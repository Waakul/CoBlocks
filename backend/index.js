import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';
import http from 'http';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import sanitize from 'sanitize-filename';

import SessionManager from './utils/sessionManager.js';
import UserManager from './utils/userManager.js';
import * as fileStorageUtils from './utils/fileStorage.js';
import { installCleaningJob } from './utils/removeOldProjects.js';
import { countRecentShared, installRecentDataJobs, recordPopup, saveRecent } from './utils/recentUsers.js';
import { setPaths, authenticate, fullAuthenticate } from './utils/scratch-auth.js';
import { reconcileProjectReferences, userOwnsProject } from './utils/projectAccess.js';
import { canDeleteBackpackItem, MAX_BACKPACK_ITEMS, normalizeBackpack, validateBackpackItem } from './utils/backpack.js';
import { isScratchProjectJson } from './utils/projectSnapshot.js';
import { createInvite, isInviteValid } from './utils/inviteLinks.js';
import SocketServer from './WebSockets.js';

const app = express();
const api = express.Router();
const API_PREFIX = '/apiv2';
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.use(cors({ origin: '*' }));

// Scratch project payloads can be much larger than typical API requests.
app.use(express.json({ limit: '20MB' }));

const httpServer = http.createServer(app);
const ioHttp = new Server(httpServer, {
    cors: { origin: '*' },
    path: `${API_PREFIX}/socket.io`,
    maxHttpBufferSize: 2e7, // 20MB limit for socket payloads
});

export let isFinalSaving = false;
const restartMessage = 'The CoBlocks server is restarting. You will lose connection for a few seconds.';

const sleep = (millis) => new Promise(res => setTimeout(res, millis));
const apiRequests = new Map();
const API_RATE_WINDOW_MS = 60_000;
const configuredApiRateLimit = Number(process.env.API_RATE_LIMIT || 300);
const API_RATE_LIMIT = Number.isFinite(configuredApiRateLimit) && configuredApiRateLimit > 0 ? configuredApiRateLimit : 300;
const validProjectId = value => /^\d{1,20}$/.test(String(value));

function requireProjectAccess(res, username, token, projectId) {
    if (!authenticate(username, token)) {
        res.status(401).send({ noauth: true });
        return false;
    }
    if (!fullAuthenticate(username, token, projectId)) {
        res.status(403).send({ noaccess: true });
        return false;
    }
    return true;
}

app.use((req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let bucket = apiRequests.get(key);
    if (!bucket || now - bucket.startedAt >= API_RATE_WINDOW_MS) {
        bucket = { count: 0, startedAt: now };
        apiRequests.set(key, bucket);
    }
    bucket.count++;
    if (apiRequests.size > 10_000) {
        for (const [address, value] of apiRequests) {
            if (now - value.startedAt >= API_RATE_WINDOW_MS) apiRequests.delete(address);
        }
    }
    if (bucket.count > API_RATE_LIMIT) {
        res.set('Retry-After', String(Math.ceil((bucket.startedAt + API_RATE_WINDOW_MS - now) / 1000)));
        return res.status(429).send({ err: 'Too many requests. Try again shortly.' });
    }
    next();
});

console.log('Booting server... Projects will load when requested.');
fileStorageUtils.initializeStorageRecovery();
const savedLastId = Number(fs.existsSync(fileStorageUtils.lastIdPath) ? fs.readFileSync(fileStorageUtils.lastIdPath, 'utf8') : 0);
const lastId = fs.readdirSync(fileStorageUtils.projectStoragePath).reduce((max, name) => {
    const id = Number(name);
    return Number.isSafeInteger(id) ? Math.max(max, id) : max;
}, Number.isSafeInteger(savedLastId) ? savedLastId : 0);
const sessionManager = SessionManager.fromJSON({ lastId });
const userManager = new UserManager();
setPaths(api, userManager, sessionManager);

fileStorageUtils.saveLoop(() => isFinalSaving);
installRecentDataJobs();

async function finalSave(sessionManager) {
    if (isFinalSaving) return;
    try {
        isFinalSaving = true;
        console.log(`Broadcasting restart message: "${restartMessage}"`);
        sessionManager.broadcastMessageToAllActiveProjects(restartMessage);

        await sleep(2000);
        console.log('Initiating final database save...');

        const lastIdTemp = `${fileStorageUtils.lastIdPath}.${process.pid}.tmp`;
        fs.writeFileSync(lastIdTemp, sessionManager.lastId.toString());
        fs.renameSync(lastIdTemp, fileStorageUtils.lastIdPath);

        await sessionManager.finalSaveAllProjects();
        fileStorageUtils.saveMapToFolder(userManager.users, fileStorageUtils.usersPath);

        await saveRecent();

        console.log('Final save complete. Exiting process safely.');
        process.exit(0);
    } catch (e) {
        console.error('CRITICAL: Error occurred during final save sequence!', e);
        await sleep(10000);
        isFinalSaving = false;
    }
}

setTimeout(() => installCleaningJob(sessionManager, userManager), 10000);
new SocketServer(ioHttp, sessionManager, userManager);

api.post('/newProject/:scratchId/:owner', (req, res) => {
    if (!authenticate(req.params.owner, req.headers.authorization)) return res.status(401).send({ noauth: true });
    if (!validProjectId(req.params.scratchId) || sanitize(req.params.scratchId.toString()) === '') {
        return res.send({ err: 'invalid scratch id' });
    }
    if (!isScratchProjectJson(req.body)) return res.status(400).send({ err: 'Invalid Scratch project data.' });

    let project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!project) {
        console.log(`Creating new project: ${req.params.scratchId} by ${req.params.owner}`);
        project = sessionManager.newProject(req.params.owner, req.params.scratchId, req.body, req.query.title);
        if (!project) return res.status(500).send({ err: 'Could not create the CoBlocks project.' });
        userManager.newProject(req.params.owner, project.id);
        sessionManager.persistProject(project.id);
        userManager.persistUser(req.params.owner);
    } else if (!sessionManager.canUserAccessProject(req.params.owner, project.id)) {
        return res.status(409).send({ err: 'This Scratch project is already linked to another CoBlocks project.' });
    }
    res.send({ id: project.id });
});

api.get('/lsId/:scratchId/:uname', (req, res) => {
    if (!authenticate(req.params.uname, req.headers.authorization)) return res.status(401).send({ noauth: true });
    const entry = sessionManager.getScratchProjectEntry(req.params.scratchId);
    const lsId = entry?.lsId;
    if (!lsId) return res.send(null);

    const project = sessionManager.getProject(lsId);
    if (!project) {
        return res.send(null);
    }

    const hasAccess = fullAuthenticate(req.params.uname, req.headers.authorization, lsId);
    res.send(hasAccess ? lsId : null);
});

api.get('/scratchIdInfo/:scratchId', (req, res) => {
    if (!validProjectId(req.params.scratchId)) return res.status(400).send({ err: 'Invalid Scratch project ID.' });
    const entry = sessionManager.getScratchProjectEntry(req.params.scratchId);
    if (!entry) return res.status(404).send({ err: 'No CoBlocks project is linked to this Scratch project.' });
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, entry.lsId)) return;
    res.send(entry);
});

api.get('/projectTitle/:id', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!project) {
        res.send({ err: `Could not find a CoBlocks project with ID ${req.params.id}.` });
    } else {
        res.send({ title: project.project.title });
    }
});

api.post('/projectSavedJSON/:lsId/:version', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.lsId)) return;
    if (!isScratchProjectJson(req.body)) return res.status(400).send({ err: 'Invalid Scratch project data.' });
    const version = Number(req.params.version);
    if (!Number.isFinite(version) || version < -1) return res.status(400).send({ err: 'Invalid project version.' });

    const project = sessionManager.getProject(req.params.lsId);
    if (!project) {
        console.log(`Could not find project: ${req.params.lsId}`);
        return res.send({ err: 'Couldn\'t find the specified project!' });
    }
    project.scratchSavedJSON(req.body, version);
    if (!sessionManager.persistProject(req.params.lsId)) return res.status(500).send({ err: 'Could not safely save the project.' });
    res.send({ success: 'Successfully saved the project!' });
});

api.get('/projectJSON/:lsId', (req, res) => {
    if (!authenticate(req.query.username, req.headers.authorization)) return res.status(401).send({ noauth: true });
    const project = sessionManager.getProject(req.params.lsId);
    if (!project) return res.sendStatus(404);
    if (!sessionManager.canUserAccessProject(req.query.username, req.params.lsId)) return res.status(403).send({ noaccess: true });

    res.send({ json: project.projectJson, version: project.jsonVersion });
});

api.use('/html', express.static('static'));

api.get('/changesSince/:id/:version', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.send([]);

    const oldestChange = project.project.getIndexZeroVersion();
    const clientVersion = parseFloat(req.params.version);
    const jsonVersion = project.jsonVersion;
    const forceReload = clientVersion < oldestChange - 1 && jsonVersion >= oldestChange - 1;

    if (clientVersion < oldestChange - 1 && jsonVersion < oldestChange - 1) {
        console.error('Client and JSON versions are both too old!', {
            id: project.id,
            jsonVersion,
            clientVersion,
            oldestChange,
        });
    }

    let changes = project.project.getChangesSinceVersion(clientVersion);
    if (forceReload) {
        changes = ListToObj(changes);
        changes.forceReload = true;
    }
    res.send(changes);
});

// Helper for format conversion
function ListToObj(list) {
    const output = { length: list.length };
    for (let i = 0; i < list.length; i++) {
        output[i] = list[i];
    }
    return output;
}

api.get('/chat/:id', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;
    const project = sessionManager.getProject(req.params.id);
    res.send(project ? project.getChat() : []);
});

api.get('/backpack/:id', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;
    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    res.send(normalizeBackpack(project));
});

api.post('/backpack/:id', (req, res) => {
    const username = req.headers.uname;
    if (!requireProjectAccess(res, username, req.headers.authorization, req.params.id)) return;
    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    const backpack = normalizeBackpack(project);
    if (backpack.length >= MAX_BACKPACK_ITEMS) return res.status(409).send({ err: `The shared backpack can hold up to ${MAX_BACKPACK_ITEMS} scripts.` });
    const validated = validateBackpackItem(req.body);
    if (validated.error) return res.status(400).send({ err: validated.error });
    const item = {
        id: randomUUID(),
        ...validated.value,
        createdBy: userManager.findUser(username)?.username || username,
        createdAt: Date.now(),
    };
    backpack.unshift(item);
    if (!sessionManager.persistProject(req.params.id)) {
        backpack.shift();
        return res.status(500).send({ err: 'Could not save the shared backpack.' });
    }
    project.session.sendChangeFrom(null, { meta: 'backpack.updated' }, true);
    res.status(201).send(item);
});

api.delete('/backpack/:id/:itemId', (req, res) => {
    const username = req.headers.uname;
    if (!requireProjectAccess(res, username, req.headers.authorization, req.params.id)) return;
    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    const backpack = normalizeBackpack(project);
    const index = backpack.findIndex(item => item.id === req.params.itemId);
    if (index === -1) return res.status(404).send({ err: 'Backpack item not found.' });
    if (!canDeleteBackpackItem(project, backpack[index], username)) return res.status(403).send({ err: 'Only the project owner or the person who shared this script can remove it.' });
    const [removed] = backpack.splice(index, 1);
    if (!sessionManager.persistProject(req.params.id)) {
        backpack.splice(index, 0, removed);
        return res.status(500).send({ err: 'Could not update the shared backpack.' });
    }
    project.session.sendChangeFrom(null, { meta: 'backpack.updated' }, true);
    res.send({ success: true });
});

// --- ADMIN / BAN ENDPOINTS ---
const adminAuth = basicAuth({
    users: JSON.parse(process.env.ADMIN_USER || '{}'),
    challenge: true,
});

api.put('/ban/:username', adminAuth, (req, res) => {
    fileStorageUtils.ban(req.params.username)
        .then(() => res.send({ success: 'Successfully banned!' }))
        .catch(err => res.send({ err }));
});

api.put('/unban/:username', adminAuth, (req, res) => {
    fileStorageUtils.unban(req.params.username)
        .then(() => res.send({ success: 'Successfully unbanned!' }))
        .catch(err => res.send({ err }));
});

api.get('/banned', adminAuth, (req, res) => {
    fileStorageUtils.getBanned()
        .then(bannedList => res.send(bannedList))
        .catch(err => res.send({ err }));
});

// Cache stats calculations to avoid blocking event loops under high traffic
let cachedStats = null;
let cachedStatsTime = 0;
const cachedStatsLifetimeMillis = 5000; // Increased to 5s for better performance

api.get('/stats', adminAuth, (req, res) => {
    if (Date.now() - cachedStatsTime > cachedStatsLifetimeMillis) {
        cachedStats = sessionManager.getStats();
        cachedStats.cachedAt = new Date();
        cachedStatsTime = Date.now();
    }
    res.send(cachedStats);
});

api.get('/dau/:days', (req, res) => {
    const days = Number(req.params.days);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
        return res.status(400).send({ err: 'Days must be between 0 and 365.' });
    }
    res.send(String(countRecentShared(days)));
});

api.put('/linkScratch/:scratchId/:lsId/:owner', (req, res) => {
    if (!validProjectId(req.params.scratchId) || !validProjectId(req.params.lsId)) return res.status(400).send({ err: 'Invalid project ID.' });
    if (!requireProjectAccess(res, req.params.owner, req.headers.authorization, req.params.lsId)) return;
    const result = sessionManager.linkProject(req.params.lsId, req.params.scratchId, req.params.owner, 0);
    if (!result?.ok) return res.status(result?.conflict ? 409 : 400).send({ err: result?.error || 'Could not link project.' });
    sessionManager.persistProject(req.params.lsId);
    res.send({ success: 'Successfully linked!' });
});

api.get('/userExists/:username', (req, res) => {
    res.send(userManager.userExists(req.params.username) && !userManager.getUser(req.params.username).privateMe);
});

api.put('/privateMe/:username/:private', (req, res) => {
    const unameClean = sanitize(req.params.username);
    if (!authenticate(unameClean, req.headers.authorization)) return res.status(401).send({ noauth: true });
    userManager.getUser(unameClean).privateMe = req.params.private === 'true';
    userManager.persistUser(unameClean);
    res.sendStatus(200);
});

api.get('/privateMe/:username', (req, res) => {
    const unameClean = sanitize(req.params.username);
    if (!authenticate(unameClean, req.headers.authorization)) return res.status(401).send({ noauth: true });
    res.send(userManager.getUser(unameClean).privateMe);
});

api.get('/userRedirect/:scratchId/:username', (req, res) => {
    if (!authenticate(req.params.username, req.headers.authorization)) {
        return res.status(401).send({ noauth: true, goto: 'none' });
    }
    const project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!project) return res.send({ goto: 'none' });
    if (!fullAuthenticate(req.params.username, req.headers.authorization, project.id)) {
        return res.status(403).send({ noaccess: true, goto: 'none' });
    }

    const ownedProject = project.getOwnersProject(req.params.username);
    if (ownedProject) {
        res.send({ goto: ownedProject.scratchId });
    } else {
        res.send({ goto: 'new', lsId: project.id });
    }
});

api.get('/active/:lsId', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.lsId)) return;

    const activeProj = sessionManager.getProject(req.params.lsId);
    const usernames = activeProj?.session.getConnectedUsernames();
    const clients = activeProj?.session.getConnectedUsersClients();
    if (usernames) {
        res.send(usernames.map(name => {
            const user = userManager.getUser(name);
            return { username: user.username, pk: user.pk, cursor: clients[name]?.cursor };
        }));
    } else {
        res.send({ err: `could not get users for project with id: ${req.params.lsId}` });
    }
});

api.get('/', (req, res) => {
    res.send('CoBlocks API');
});

api.post('/friends/:user/:friend', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.status(401).send({ noauth: true });
    if (!userManager.userExists(req.params.friend)) return res.sendStatus(404);

    userManager.befriend(req.params.user, req.params.friend);
    userManager.persistUser(req.params.user);
    res.send({ success: 'Successfully friended!' });
});

api.delete('/friends/:user/:friend', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.status(401).send({ noauth: true });
    userManager.unbefriend(req.params.user, req.params.friend);
    userManager.persistUser(req.params.user);
    res.send({ success: 'Succesfully unfriended!' });
});

api.get('/friends/:user', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.status(401).send({ noauth: true });
    recordPopup(req.params.user);
    res.send(userManager.getUser(req.params.user)?.friends);
});

api.get('/userProjects/:user', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.status(401).send({ noauth: true });
    const user = userManager.findUser(req.params.user);
    const { authorizedIds, removedIds } = reconcileProjectReferences(req.params.user, user, id => sessionManager.getProject(id));
    if (removedIds.length) userManager.persistUser(req.params.user);
    const owned = new Set((user?.myProjects || []).map(String));
    res.send(authorizedIds.filter(id => !owned.has(String(id))));
});

api.get('/userProjectsScratch/:user', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.status(401).send({ noauth: true });

    const user = userManager.findUser(req.params.user);
    const { authorizedIds: projectIds, removedIds } = reconcileProjectReferences(
        req.params.user,
        user,
        id => sessionManager.getProject(id),
    );
    if (removedIds.length) {
        console.warn(`Removed ${removedIds.length} stale project reference(s) from ${req.params.user}.`);
        userManager.persistUser(req.params.user);
    }
    const projectsList = projectIds.map(id => {
        const project = sessionManager.getProject(id);
        if (!project) return null;

        const ownerProj = project.getOwnersProject(req.params.user);
        return {
            scratchId: ownerProj ? ownerProj.scratchId : project.scratchId,
            lsId: project.id,
            title: project.project.title,
            lastTime: project.project.lastTime,
            lastUser: project.project.lastUser,
            online: project.session.getConnectedUsernames(),
        };
    }).filter(Boolean);

    res.send(projectsList);
});

api.put('/leaveScratchId/:scratchId/:username', (req, res) => {
    const project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    if (!requireProjectAccess(res, req.params.username, req.headers.authorization, project.id)) return;

    const previousOwner = project.owner;
    userManager.unShare(req.params.username, project.id);
    sessionManager.unshareProject(project.id, req.params.username);
    if (previousOwner?.toLowerCase() === req.params.username.toLowerCase() && project.owner) {
        userManager.unShare(project.owner, project.id);
        userManager.newProject(project.owner, project.id);
        userManager.persistUser(project.owner);
    }
    if (project.owner) sessionManager.persistProject(project.id);
    userManager.persistUser(req.params.username);
    res.send({ success: 'User successfully removed!' });
});

api.put('/leaveLSId/:lsId/:username', (req, res) => {
    if (!authenticate(req.params.username, req.headers.authorization)) return res.status(401).send({ noauth: true });
    const project = sessionManager.getProject(req.params.lsId);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    if (!sessionManager.canUserAccessProject(req.params.username, req.params.lsId)) return res.status(403).send({ noaccess: true });

    const previousOwner = project.owner;
    userManager.unShare(req.params.username, req.params.lsId);
    sessionManager.unshareProject(req.params.lsId, req.params.username);
    if (previousOwner?.toLowerCase() === req.params.username.toLowerCase() && project.owner) {
        userManager.unShare(project.owner, project.id);
        userManager.newProject(project.owner, project.id);
        userManager.persistUser(project.owner);
    }
    if (project.owner) sessionManager.persistProject(project.id);
    userManager.persistUser(req.params.username);
    res.send({ success: 'User successfully removed!' });
});

api.get('/share/:id', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    let list = project?.sharedWith;
    if (!list) return res.send({ err: 'No shared list found for the specified project.' });

    list = list.map(name => ({ username: name, pk: userManager.findUser(name)?.pk }));
    res.send([{ username: project.owner, pk: userManager.findUser(project.owner)?.pk }].concat(list));
});

api.put('/share/:id/:to/:from', (req, res) => {
    if (!requireProjectAccess(res, req.params.from, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!userOwnsProject(project, req.params.from)) return res.status(403).send({ err: 'Only the project owner can add collaborators.' });
    if (userOwnsProject(project, req.params.to)) {
        return res.send({ err: 'Cannot share the project with the owner.' });
    }

    if (!userManager.userExists(req.params.to)) return res.sendStatus(404);

    const profileId = typeof req.query.pk === 'string' ? req.query.pk.slice(0, 64) : undefined;
    sessionManager.shareProject(req.params.id, req.params.to);
    userManager.getUser(req.params.to).pk = profileId;
    userManager.share(req.params.to, req.params.id, req.params.from);
    sessionManager.persistProject(req.params.id);
    userManager.persistUser(req.params.to);
    res.send({ success: 'Project successfully shared.' });
});

api.put('/unshare/:id/:to/', (req, res) => {
    if (!requireProjectAccess(res, req.headers.uname, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!userOwnsProject(project, req.headers.uname)) return res.status(403).send({ err: 'Only the project owner can remove collaborators.' });
    if (userOwnsProject(project, req.params.to)) {
        return res.send({ err: 'Cannot unshare the project with the owner.' });
    }
    if (!project.sharedWith.some(name => String(name).toLowerCase() === req.params.to.toLowerCase())) {
        return res.status(404).send({ err: 'That user is not a collaborator on this project.' });
    }

    sessionManager.unshareProject(req.params.id, req.params.to);
    userManager.unShare(req.params.to, req.params.id);
    sessionManager.persistProject(req.params.id);
    userManager.persistUser(req.params.to);
    res.send({ success: 'Project successfully unshared.' });
});

api.post('/invite/:id', (req, res) => {
    const username = req.headers.uname;
    if (!requireProjectAccess(res, username, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!userOwnsProject(project, username)) return res.status(403).send({ err: 'Only the project owner can create an invite.' });

    const { token, storedInvite } = createInvite();
    const previousInvite = project.collaborationInvite;
    project.collaborationInvite = storedInvite;
    if (!sessionManager.persistProject(project.id)) {
        project.collaborationInvite = previousInvite;
        return res.status(500).send({ err: 'Could not save the invite.' });
    }

    res.status(201).send({
        projectId: String(project.id),
        token,
        expiresAt: storedInvite.expiresAt,
    });
});

api.delete('/invite/:id', (req, res) => {
    const username = req.headers.uname;
    if (!requireProjectAccess(res, username, req.headers.authorization, req.params.id)) return;

    const project = sessionManager.getProject(req.params.id);
    if (!userOwnsProject(project, username)) return res.status(403).send({ err: 'Only the project owner can revoke an invite.' });

    const previousInvite = project.collaborationInvite;
    project.collaborationInvite = null;
    if (!sessionManager.persistProject(project.id)) {
        project.collaborationInvite = previousInvite;
        return res.status(500).send({ err: 'Could not revoke the invite.' });
    }
    res.send({ success: true });
});

api.post('/invite/:id/accept', (req, res) => {
    const username = req.headers.uname;
    if (!authenticate(username, req.headers.authorization)) return res.status(401).send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.status(404).send({ err: 'Project not found.' });
    if (!isInviteValid(project.collaborationInvite, req.body?.token)) {
        return res.status(403).send({ err: 'This invite is invalid or has expired.' });
    }

    if (!userOwnsProject(project, username)) {
        sessionManager.shareProject(project.id, username);
        userManager.share(username, project.id, project.owner, true);
        if (!sessionManager.persistProject(project.id) || !userManager.persistUser(username)) {
            return res.status(500).send({ err: 'Could not save project access.' });
        }
    }

    res.send({
        success: true,
        projectId: String(project.id),
        scratchId: project.getOwnersProject(username)?.scratchId || null,
    });
});

app.use(API_PREFIX, api);

const port = process.env.PORT;
httpServer.listen(port, '0.0.0.0');
console.log(`Listening HTTP on port ${port}`);

// --- 4. CLEAN EXIT SYSTEM PROCESSES ---
process.stdin.resume();

async function exitHandler(options, exitCode) {
    if (options.cleanup) console.log('Cleaning environment...');
    if (exitCode || exitCode === 0) console.log(`Exit Code: ${exitCode}`);
    if (options.exit) {
        await finalSave(sessionManager);
    }
}

process.on('exit', exitHandler.bind(null, { cleanup: true }));
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception thrown!', err);
    exitHandler({ exit: true }, 1);
});
