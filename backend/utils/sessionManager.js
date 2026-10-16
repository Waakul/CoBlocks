import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { deleteRecoveryCopies, projectStoragePath, lastIdPath, readRecoveryCopy, saveMapToFolder, saveMapToFolderAsync, projectLinksPath } from './fileStorage.js';
import { countPopup, countRecent, countRecentRealtime, countRecentShared, countUniquePopup } from './recentUsers.js';
import { getAuthStats } from './scratch-auth.js';
import { numWithCreds, numWithoutCreds } from './scratch-auth.js';
import { scratchLinkConflicts } from './projectAccess.js';
import { isScratchProjectJson } from './projectSnapshot.js';

const OFFLOAD_DELAY_MS = 45_000;

class ProjectHistory {
    // A change version is the state after applying that change. jsonVersion is
    // the last change already included in the full project snapshot.

    static fromJSON(json) {
        const ret = new ProjectHistory(json.title);
        Object.entries(json).forEach(entry => {
            ret[entry[0]] = entry[1];
        });
        return ret;
    }

    version = -1;
    changes = [];
    lastTime = Date.now();
    lastUser = '';
    title;

    constructor(title) {
        this.title = title;
    }

    recordChange(change) {
        this.trimCostumeEdits(change);
        this.changes.push(change);
        this.version++;
        this.lastTime = Date.now();
    }

    trimCostumeEdits(newChange) {
        if (newChange.meta === 'vm.updateBitmap' || newChange.meta === 'vm.updateSvg') {
            const target = newChange.target;
            const costumeIndex = newChange.costumeIndex;
            const limit = 20;
            for (let i = this.changes.length - 1; i >= 0 && i >= this.changes.length - limit; i--) {
                const change = this.changes[i];
                const spn = change?.data?.name;
                if (spn === 'reordercostume' || spn === 'renamesprite') break;
                if ((change.meta === 'vm.updateBitmap' || change.meta === 'vm.updateSvg')
                    && change.target === target
                    && change.costumeIndex === costumeIndex) {
                    this.changes[i] = { meta: 'version++' };
                }
            }
        }
    }

    getChangesSinceVersion(lastVersion) {
        return this.changes.slice(Math.max(0, lastVersion - this.getIndexZeroVersion()));
    }
    getIndexZeroVersion() {
        return this.version - this.changes.length + 1;
    }

    trimChanges(limit = 0) {
        const retainedChanges = Math.max(0, Math.min(Math.floor(Number(limit) || 0), this.changes.length));
        this.changes = retainedChanges === 0 ? [] : this.changes.slice(-retainedChanges);
    }
}

class SessionClient {
    isReady = true;
    username;
    socket;

    cursor = { targetName: null, scale: 1, scrollX: 0, scrollY: 0, cursorX: 0, cursorY: 0, editorTab: 0 };

    constructor(socket, username) {
        this.socket = socket;
        this.username = username;
    }

    trySendMessage(data) {
        if (this.isReady) { this.socket.send(data); }
    }

    id() {
        return this.socket?.id;
    }

}

class ProjectSession {
    connectedClients = {};
    project;
    id;

    constructor(project, id) {
        this.project = project;
        this.id = id;
    }

    addClient(client) {
        this.connectedClients[client.id()] = client;
        this.getWonkySockets();
    }
    removeClient(id) {
        const username = this.connectedClients[id]?.username;
        delete this.connectedClients[id];
        return username;
    }

    getClientFromSocket(socket) {
        return this.connectedClients[socket?.id];
    }

    getConnectedUsernames() {
        return [...(new Set(Object.values(this.connectedClients).map(client => client.username?.toLowerCase())))];
    }

    // get one client per username
    getConnectedUsersClients() {
        const clients = {};
        Object.values(this.connectedClients).forEach(client => { clients[client.username.toLowerCase()] = client; });
        return clients;
    }

    sendChangeFrom(socket, msg, excludeVersion) {
        Object.values(this.connectedClients).forEach(client => {
            if (!socket || socket.id !== client.id()) {
                client.trySendMessage({
                    type: 'projectChange',
                    lsId: this.id,
                    version: excludeVersion ? null : this.project.version,
                    msg,
                    from: socket?.id,
                    user: this.getClientFromSocket(socket)?.username,
                });
            }
        });
    }

    onProjectChange(socket, msg) {
        const client = this.getClientFromSocket(socket);
        msg.user = client?.username;
        this.project.recordChange(msg);
        this.project.lastUser = client ? client.username : this.project.lastUser;
        this.sendChangeFrom(socket, msg);
    }

    getWonkySockets() {
        const staleClientIds = [];
        for (const [clientId, client] of Object.entries(this.connectedClients)) {
            if (client.socket.disconnected || client.socket.id !== clientId) {
                staleClientIds.push(clientId);
                delete this.connectedClients[clientId];
                console.warn('Removed stale socket reference:', clientId);
            }
        }
        return staleClientIds;
    }
}

class CollaborativeProject {

    toJSON() {
        const ret = {
            project: this.project,
            id: this.id,
            scratchId: this.scratchId,
            projectJson: this.projectJson,
            jsonVersion: this.jsonVersion,
            linkedWith: this.linkedWith,
            owner: this.owner,
            sharedWith: this.sharedWith,
            collaborationInvite: this.collaborationInvite,
            backpack: this.backpack,
            chat: this.chat,
        };
        return ret;
    }

    static fromJSON(json) {
        const ret = new CollaborativeProject('&');
        Object.entries(json).forEach(entry => {
            if (entry[0] !== 'project') {
                ret[entry[0]] = entry[1];
            }
        });
        ret.project = ProjectHistory.fromJSON(json.project);
        ret.session = new ProjectSession(ret.project, ret.id);
        return ret;
    }

    session;
    project;

    // CoBlocks project ID. Legacy serialized property names are retained so
    // existing installations can load their stored data.
    id;
    // most recently saved json
    projectJson;
    // json version
    jsonVersion = 0;

    // // most up to date scratch project id
    scratchId;
    // // index of next change i think
    // scratchVersion = 0
    linkedWith = []; // {scratchId, owner}

    owner;
    sharedWith = [];
    collaborationInvite = null;

    backpack = [];

    chat = [];
    static defaultChat = { sender: 'CoBlocks', text: 'Welcome! Chat is public, monitored, and filtered. Report inappropriate things and bugs to @Waakul.' };

    constructor(owner, scratchId, projectJson, lsId, title) {
        if (owner === '&') return;
        this.id = lsId;
        this.owner = owner;
        this.projectJson = projectJson;
        this.scratchId = scratchId;
        this.project = new ProjectHistory(title);
        this.session = new ProjectSession(this.project, this.id);
        this.linkedWith.push({ scratchId, owner });
        this.chat.push(CollaborativeProject.defaultChat);
    }


    onChat(msg, socket) {
        this.chat.push(msg.msg);
        this.session.sendChangeFrom(socket, msg, true);
        this.trimChat(500);
    }
    getChat() {
        return this.chat;
    }
    trimChat(n) {
        const retainedMessages = Math.max(0, Math.min(Math.floor(Number(n) || 0), this.chat.length));
        this.chat = retainedMessages === 0 ? [] : this.chat.slice(-retainedMessages);
    }
    serverSendChat(message, from) {
        if (!from) { from = 'CoBlocks'; }
        const msg = {
            'meta': 'chat',
            'msg': {
                'sender': from,
                'text': message,
                'linkify': true,
            },
        };
        this.session.sendChangeFrom(null, msg, true);
    }

    trimChanges(limit = this.project.version - this.jsonVersion) {
        this.project.trimChanges(limit);
    }

    isSharedWith(username) {
        return username === this.owner || this.sharedWith.includes(username);
    }
    isSharedWithCaseless(username) {
        username = String(username).toLowerCase();
        const owner = String(this.owner).toLowerCase();
        const sharedWithLowercase = this.sharedWith.map(un => String(un).toLowerCase());
        return username === owner || sharedWithLowercase.includes(username);
    }

    scratchSavedJSON(json, version) {
        if (version <= this.jsonVersion) return;
        this.projectJson = json;
        this.jsonVersion = version;
        this.trimChanges();
    }

    linkProject(scratchId, owner) {
        const normalizedScratchId = String(scratchId);
        const normalizedOwner = String(owner).toLowerCase();
        const alreadyLinked = this.linkedWith.some(project =>
            String(project.scratchId) === normalizedScratchId &&
            String(project.owner).toLowerCase() === normalizedOwner,
        );
        if (!alreadyLinked) this.linkedWith.push({ scratchId: normalizedScratchId, owner });
    }

    getOwnersProject(owner) {
        return this.linkedWith.find(project => project.owner?.toLowerCase() === owner?.toLowerCase());
    }

    joinSession(socket, username) {
        if (socket.id in this.session.connectedClients) { return; }
        const client = new SessionClient(socket, username);
        this.session.addClient(client);
        if (!this.project.lastUser) { this.project.lastUser = username; }
    }
}

export default class SessionManager {

    toJSON() {
        const ret = {
            livescratch: this.projects,
            lastId: this.lastId,
        };
        return ret;

    }
    static fromJSON(ob) {
        const ret = new SessionManager();
        if (ob.lastId) { ret.lastId = ob.lastId; }
        if (ob.livescratch) {
            Object.entries(ob.livescratch).forEach(entry => {
                ret.projects[entry[0]] = CollaborativeProject.fromJSON(entry[1]);
            });
        }

        return ret;
    }

    static inst;


    // In-memory CoBlocks projects keyed by project ID.
    projects = {};
    socketMap = {};

    lastId = 0;

    constructor() {
        SessionManager.inst = this;
    }

    offloadStaleProjects() {
        Object.entries(this.projects).forEach(entry => {
            const project = entry[1];
            const id = entry[0];
            if (Object.keys(project.session.connectedClients).length === 0) {
                project.project.trimChanges(20);
                this.offloadProject(id);
            }
        });
    }
    finalSaveAllProjects() {
        Object.entries(this.projects).forEach(entry => {
            const project = entry[1];
            project.trimChanges();
        });
        if (saveMapToFolder(this.projects, projectStoragePath)) this.projects = {};
    }
    async finalSaveAllProjectsAsync() {
        Object.entries(this.projects).forEach(entry => {
            const project = entry[1];
            project.trimChanges();
        });
        if (await saveMapToFolderAsync(this.projects, projectStoragePath)) this.projects = {};
    }
    async offloadStaleProjectsAsync() {
        for (const entry of Object.entries(this.projects)) {
            const project = entry[1];
            const id = entry[0];
            if (Object.keys(project.session.connectedClients).length === 0) {
                project.project.trimChanges(20);
                await this.offloadProjectAsync(id);
            }
        }
    }
    offloadProjectIfStale(id) {
        const project = this.projects[id];
        if (!project) { return; }
        if (Object.keys(project.session.connectedClients).length === 0) {
            project.trimChanges();
            this.offloadProject(id);
        } else {
            this.renewOffloadTimeout(id);
        }
    }
    offloadProject(id) {
        try {
            this.projects[id]?.trimChanges();
            const projectsToSave = {};
            projectsToSave[id] = this.projects[id];
            if (projectsToSave[id]) { // only save it if there is actual data to save
                if (!saveMapToFolder(projectsToSave, projectStoragePath)) return;
            }
            delete this.projects[id];
        } catch (e) { console.error(e); }
    }
    async offloadProjectAsync(id) {
        try {
            const projectsToSave = {};
            const project = this.projects[id];
            projectsToSave[id] = project;
            if (projectsToSave[id]) { // only save it if there is actual data to save
                if (!await saveMapToFolderAsync(projectsToSave, projectStoragePath)) return;
            }
            if (project && this.projects[id] === project && !Object.keys(project.session.connectedClients).length) delete this.projects[id];
        } catch (e) { console.error(e); }
    }
    reloadProject(id) {
        id = sanitize(id + '');
        const filename = projectStoragePath + path.sep + id;
        if (!(id in this.projects)) {
            try {
                let file;
                try { file = fs.readFileSync(filename); } catch { file = null; }
                let json;
                try {
                    json = JSON.parse(file);
                    if (!isScratchProjectJson(json?.projectJson)) throw new Error('Invalid Scratch project snapshot');
                    CollaborativeProject.fromJSON(json);
                } catch {
                    const recovered = readRecoveryCopy(projectStoragePath, id, value => value?.project && isScratchProjectJson(value?.projectJson) && String(value?.id) === String(id));
                    if (!recovered) return;
                    json = JSON.parse(recovered);
                    saveMapToFolder({ [id]: json }, projectStoragePath);
                    console.warn(`Recovered CoBlocks project ${id} from a redundant copy.`);
                }
                const project = CollaborativeProject.fromJSON(json);
                this.projects[id] = project;
            } catch (e) {
                console.error('reloadProject: couldn\'t read project with id: ' + id + '. err msg: ', e);
            }
        }
    }
    async reloadProjectAsync(id) {

        id = sanitize(id + '');
        if (!(id in this.projects)) {
            try {

                let file;
                try { file = await fsp.readFile(projectStoragePath + path.sep + id); } catch { file = null; }
                let json;
                try {
                    json = JSON.parse(file);
                    if (!isScratchProjectJson(json?.projectJson)) throw new Error('Invalid Scratch project snapshot');
                    CollaborativeProject.fromJSON(json);
                } catch {
                    const recovered = readRecoveryCopy(projectStoragePath, id, value => value?.project && isScratchProjectJson(value?.projectJson) && String(value?.id) === String(id));
                    if (!recovered) return;
                    json = JSON.parse(recovered);
                    saveMapToFolder({ [id]: json }, projectStoragePath);
                    console.warn(`Recovered CoBlocks project ${id} from a redundant copy.`);
                }
                const project = CollaborativeProject.fromJSON(json);
                this.projects[id] = project;
            } catch (e) {
                console.error('reloadProject: couldn\'t read project with id: ' + id + '. err msg: ', e);
            }
        }
    }

    linkProject(id, scratchId, owner, version) {
        const project = this.getProject(id);
        if (!project) return { ok: false, error: 'Project not found.' };
        const existingEntry = this.getScratchProjectEntry(scratchId);
        if (scratchLinkConflicts(existingEntry, id)) {
            return { ok: false, conflict: true, error: 'This Scratch project is already linked to another CoBlocks project.' };
        }
        project.linkProject(scratchId, owner, version);
        if (!this.makeScratchProjectEntry(scratchId, owner, id)) {
            return { ok: false, error: 'Could not save the Scratch project link.' };
        }
        return { ok: true };
    }

    // constructor(owner,scratchId,json,lsId,title) {
    newProject(owner, scratchId, json, title) {
        if (this.doesScratchProjectEntryExist(scratchId)) {
            const entry = this.getScratchProjectEntry(scratchId);
            const existingProject = entry?.lsId ? this.getProject(entry.lsId) : null;
            if (existingProject) return existingProject;
            this.deleteScratchProjectEntry(scratchId, entry?.lsId);
        }
        const id = String(this.getNextId());
        const project = new CollaborativeProject(owner, scratchId, json, id, title);
        this.projects[id] = project;
        if (!this.makeScratchProjectEntry(scratchId, owner, id)) {
            delete this.projects[id];
            return null;
        }

        return project;
    }

    join(socket, id, username) {
        const project = this.getProject(id);
        if (!project) return false;
        const socketIdentity = this.socketMap[socket.id]?.username;
        if (socketIdentity && String(socketIdentity).toLowerCase() !== String(username).toLowerCase()) return false;
        project.joinSession(socket, username);
        if (!(socket.id in this.socketMap)) {
            this.socketMap[socket.id] = { username: username, projects: [] };
        }
        if (!this.socketMap[socket.id].projects.some(projectId => String(projectId) === String(project.id))) {
            this.socketMap[socket.id].projects.push(project.id);
        }
        console.log(username + ' joined | lsId: ' + id + ', scratchId: ' + project.scratchId);
        return true;
    }
    leave(socket, id, voidMap) {
        const project = this.getProject(id);
        if (!project) { return; }
        const username = project.session.removeClient(socket.id);
        if (socket.id in this.socketMap && !voidMap) {
            const array = this.socketMap[socket.id].projects;

            const index = array.indexOf(id);
            if (index > -1) {
                array.splice(index, 1);
            }
        }
        if (Object.keys(project.session.connectedClients).length === 0) {
            project.trimChanges();
            this.offloadProject(id);
        }
        console.log(username + ' LEFT | lsId: ' + id + ', scratchId: ' + project.scratchId);
    }

    disconnectSocket(socket) {
        if (!(socket.id in this.socketMap)) { return; }
        this.socketMap[socket.id].projects.forEach(projectId => { this.leave(socket, projectId, true); });
        delete this.socketMap[socket.id];
    }

    projectChange(lsId, data, socket) {
        this.getProject(lsId)?.session.onProjectChange(socket, data.msg);
    }

    getVersion(lsId) {
        return this.getProject(lsId)?.project.version;
    }

    getNextId() {
        this.lastId++;
        this.tryWriteLastId();
        return this.lastId;
    }

    tryWriteLastId() {
        try {
            const temp = `${lastIdPath}.${process.pid}.tmp`;
            fs.writeFileSync(temp, this.lastId.toString());
            fs.renameSync(temp, lastIdPath);
        } catch (e) { console.error(e); }
    }

    attachScratchProject(scratchId, owner, projectId) {
        this.makeScratchProjectEntry(scratchId, owner, projectId);
    }

    offloadTimeoutIds = {};
    renewOffloadTimeout(lsId) {
        clearTimeout(this.offloadTimeoutIds[lsId]);
        delete this.offloadTimeoutIds[lsId];
        const timeout = setTimeout(() => { this.offloadProjectIfStale(lsId); }, OFFLOAD_DELAY_MS);
        this.offloadTimeoutIds[lsId] = timeout;

    }

    getProject(lsId) {
        this.renewOffloadTimeout(lsId);
        this.reloadProject(lsId);
        return this.projects[lsId];
    }
    async getProjectAsync(lsId) {
        this.renewOffloadTimeout(lsId);
        await this.reloadProjectAsync(lsId);
        return this.projects[lsId];
    }
    shareProject(id, user) {
        const project = this.getProject(id);
        if (!project) { return; }
        const normalizedUser = String(user).toLowerCase();
        if (!project.sharedWith.some(name => String(name).toLowerCase() === normalizedUser)) project.sharedWith.push(user);
    }
    unshareProject(id, user) {
        const project = this.getProject(id);
        if (!project) { return; }

        project.linkedWith.filter(proj => proj.owner.toLowerCase() === user.toLowerCase()).forEach(proj => {
            project.linkedWith.splice(project.linkedWith.indexOf(proj), 1);
            this.deleteScratchProjectEntry(proj.scratchId, project.id);
        });

        if (project.owner.toLowerCase() === user.toLowerCase()) {
            project.owner = project.sharedWith[0] ? project.sharedWith[0] : '';
        }

        const userIndex = project.sharedWith.findIndex(name => String(name).toLowerCase() === String(user).toLowerCase());
        if (userIndex !== -1) {
            project.sharedWith.splice(userIndex, 1);
        }

        if (project.owner === '') {
            this.deleteProjectFile(project.id);
        }
    }

    deleteProjectFile(id) {
        this.offloadProject(id);
        const projectPath = projectStoragePath + path.sep + sanitize(id);
        if (fs.existsSync(projectPath)) {
            try { fs.rmSync(projectPath); } catch (e) { console.error('error when deleting project file after unsharing with everyone', e); }
        }
        deleteRecoveryCopies(projectStoragePath, id);
    }

    persistProject(id) {
        const project = this.getProject(id);
        return !!project && saveMapToFolder({ [String(id)]: project }, projectStoragePath);
    }

    getScratchToLSProject(scratchId) {
        const lsId = this.getScratchProjectEntry(scratchId)?.lsId;
        if (!lsId) { return null; }
        return this.getProject(lsId);
    }

    getScratchProjectEntry(scratchId) {
        try {
            if (!scratchId) { return; }
            const scratchIdFilename = sanitize(scratchId + '');
            const filename = projectLinksPath + path.sep + scratchIdFilename;
            let file;
            try { file = fs.readFileSync(filename); } catch { file = null; }
            let entry;
            try {
                entry = JSON.parse(file);
                if (!entry?.lsId && !entry?.blId) throw new Error('Invalid project link');
            } catch {
                const recovered = readRecoveryCopy(projectLinksPath, scratchIdFilename, value => !!(value?.lsId || value?.blId));
                if (!recovered) return null;
                entry = JSON.parse(recovered);
                saveMapToFolder({ [scratchIdFilename]: entry }, projectLinksPath);
                console.warn(`Recovered Scratch project link ${scratchIdFilename} from a redundant copy.`);
            }
            if (entry && !entry.lsId && entry.blId) entry.lsId = entry.blId;
            return entry;
        } catch (e) { console.error(e); }
    }
    makeScratchProjectEntry(scratchId, owner, lsId) {
        try {
            if (!scratchId) { return false; }
            const existing = this.getScratchProjectEntry(scratchId);
            if (scratchLinkConflicts(existing, lsId)) return false;
            const scratchIdFilename = sanitize(scratchId + '');
            if (!scratchIdFilename) return false;
            const entry = { owner, lsId };
            return saveMapToFolder({ [scratchIdFilename]: entry }, projectLinksPath);
        } catch (e) { console.error(e); return false; }
    }
    doesScratchProjectEntryExist(scratchId) {
        if (!scratchId) { return false; }
        return !!this.getScratchProjectEntry(scratchId);
    }
    deleteScratchProjectEntry(scratchId, expectedLsId = null) {
        if (!scratchId) { return false; }
        if (!this.doesScratchProjectEntryExist(scratchId)) { return false; }
        const current = this.getScratchProjectEntry(scratchId);
        if (expectedLsId !== null && String(current?.lsId) !== String(expectedLsId)) return false;
        const scratchIdFilename = sanitize(scratchId + '');
        const filename = projectLinksPath + path.sep + scratchIdFilename;
        fs.rmSync(filename);
        deleteRecoveryCopies(projectLinksPath, scratchIdFilename);
        return true;
    }

    // if 'from' is null, defaults to 'CoBlocks'
    broadcastMessageToAllActiveProjects(message, from) {
        Object.entries(this.projects).forEach(entry => {
            const project = entry[1];

            try {
                if (Object.keys(project.session.connectedClients).length > 0) {
                    project.serverSendChat(message, from);
                }
            } catch (e) { console.error(e); }
        });
    }

    getStats() {
        const set1 = new Set();
        const aloneSet = new Set();
        const sharedSet = new Set();
        const collabingSet = new Set();
        const stats = {
            active1HrCollabing: 0,
            active2HrCollabing: 0,
            active24HrCollabing: 0,
            active1weekCollabing: 0,
            active30dCollabing: 0,
            active1HrRealtime: 0,
            active24HrRealtime: 0,
            active1weekRealtime: 0,
            active30dRealtime: 0,
            active1Hr: 0,
            active24Hr: 0,
            active1week: 0,
            active30d: 0,
            popup24hr: 0,
            popup1week: 0,
            popup1month: 0,
            popupUnique24hr: 0,
            popupUnique1week: 0,
            totalActiveProjects: 0,
            totalProjectsMoreThan1Editor: 0,
            usersActiveCount: 0,
            usersActiveMoreThan1EditorCount: 0,
            monthlyProjects: 0,
            monthlyScratchIds: 0,
            collabingNow: 0,
            sharedNow: 0,
            aloneNow: 0,
            usersActive: [],
            usersActiveMoreThan1Editor: [],
            projectsActiveSingleEditor: [],
            projectsActiveMoreThan1Editor: [],
            maxInOneProject: {
                id: 0,
                num: 0,
            },
        };
        Object.entries(this.projects).forEach(entry => {
            const project = entry[1];

            const connectedUsernames = project.session.getConnectedUsernames();
            try {
                if (connectedUsernames.length === 1) {
                    stats.projectsActiveSingleEditor.push(project.scratchId);
                    if (project.sharedWith?.length === 0) connectedUsernames.forEach(aloneSet.add, aloneSet);
                    if (project.sharedWith?.length > 0) connectedUsernames.forEach(sharedSet.add, sharedSet);
                }
                if (connectedUsernames.length > 0) {
                    stats.totalActiveProjects++;
                    project.session.getConnectedUsernames().forEach(set1.add, set1);
                }
                if (connectedUsernames.length > 1) {
                    stats.totalProjectsMoreThan1Editor++;
                    connectedUsernames.forEach(collabingSet.add, collabingSet);
                    stats.usersActiveMoreThan1Editor.push(connectedUsernames);
                    stats.projectsActiveMoreThan1Editor.push(project.scratchId);
                }
                if (connectedUsernames.length > stats.maxInOneProject.num) {
                    stats.maxInOneProject.num = Object.keys(project.session.connectedClients).length;
                    stats.maxInOneProject.id = project.id;
                }
            } catch (e) { console.error(e); }
        });
        stats.usersActive = Array.from(set1);
        const oldUsersActiveMoreThan1Editor = Array.from(collabingSet);
        stats.usersActiveCount = stats.usersActive.length;
        stats.usersActiveMoreThan1EditorCount = oldUsersActiveMoreThan1Editor.length;

        collabingSet.forEach(aloneSet.delete, aloneSet);
        collabingSet.forEach(sharedSet.delete, sharedSet);
        sharedSet.forEach(aloneSet.delete, aloneSet);

        stats.collabingNow = collabingSet.size;
        stats.sharedNow = sharedSet.size;
        stats.aloneNow = aloneSet.size;

        stats.active1HrCollabing = countRecentShared(1 / 24);
        stats.active2HrCollabing = countRecentShared(1 / 24 * 2);
        stats.active24HrCollabing = countRecentShared(1);
        stats.active1weekCollabing = countRecentShared(7);
        stats.active30dCollabing = countRecentShared(30);
        stats.active24HrRealtime = countRecentRealtime(1);
        stats.active2HrRealtime = countRecentRealtime(1 / 24 * 2);
        stats.active1weekRealtime = countRecentRealtime(7);
        stats.active30dRealtime = countRecentRealtime(30);
        stats.active1Hr = countRecent(1 / 24);
        stats.active1HrRealtime = countRecentRealtime(1 / 24);
        stats.active2Hr = countRecent(1 / 24 * 2);
        stats.active24Hr = countRecent(1);
        stats.active1week = countRecent(7);
        stats.active30d = countRecent(30);
        stats.popup24hr = countPopup(1);
        stats.popup1week = countPopup(7);
        stats.popup1month = countPopup(30);
        stats.popupUnique24hr = countUniquePopup(1);
        stats.popupUnique1week = countUniquePopup(7);
        stats.monthlyProjects = fs.readdirSync(projectStoragePath).length;
        stats.monthlyScratchIds = fs.readdirSync(projectLinksPath).length;

        stats.auth = getAuthStats();
        stats.auth.numWithCreds = numWithCreds;
        stats.auth.numWithoutCreds = numWithoutCreds;
        return stats;
    }

    canUserAccessProject(username, lsId) {
        const project = this.getProject(lsId);
        if (!project) { return false; }
        return project.isSharedWithCaseless(username);
    }
}
