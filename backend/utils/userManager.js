import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import sanitize from 'sanitize-filename';

import { readRecoveryCopy, saveMapToFolder, usersPath } from './fileStorage.js';

const OFFLOAD_DELAY_MS = 30_000;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

function normalizeUsername(username) {
    return typeof username === 'string' && USERNAME_PATTERN.test(username)
        ? username.toLowerCase()
        : null;
}

function createUser(username) {
    return {
        username,
        friends: [],
        token: randomBytes(32).toString('hex'),
        sharedTo: {},
        myProjects: [],
        verified: false,
        privateMe: false,
    };
}

export default class UserManager {
    users = {};
    offloadTimers = {};

    verify(username, token) {
        return Boolean(token) && this.findUser(username)?.token === token;
    }

    befriend(username, friendUsername) {
        const user = this.getUser(username);
        const friend = normalizeUsername(friendUsername);
        if (!user || !friend) return false;
        if (!user.friends.some(name => normalizeUsername(name) === friend)) user.friends.push(friend);
        return true;
    }

    unbefriend(username, friendUsername) {
        const user = this.getUser(username);
        const friend = normalizeUsername(friendUsername);
        if (!user || !friend) return false;

        const index = user.friends.findIndex(name => normalizeUsername(name) === friend);
        if (index === -1) return false;
        user.friends.splice(index, 1);
        return true;
    }

    userExists(username) {
        return Boolean(this.findUser(username));
    }

    getUser(username) {
        const normalized = normalizeUsername(username);
        if (!normalized) return null;

        this.reloadUser(normalized);
        if (!this.users[normalized]) this.users[normalized] = createUser(normalized);
        this.scheduleOffload(normalized);
        return this.users[normalized];
    }

    findUser(username) {
        const normalized = normalizeUsername(username);
        if (!normalized) return null;

        this.reloadUser(normalized);
        const user = this.users[normalized] || null;
        if (user) this.scheduleOffload(normalized);
        return user;
    }

    addUser(username) {
        return this.getUser(username);
    }

    scheduleOffload(username) {
        clearTimeout(this.offloadTimers[username]);
        this.offloadTimers[username] = setTimeout(() => this.offloadUser(username), OFFLOAD_DELAY_MS);
    }

    reloadUser(username) {
        const normalized = normalizeUsername(username);
        if (!normalized || this.users[normalized]) return;

        const filename = sanitize(normalized);
        if (!filename) return;

        const filePath = path.join(usersPath, filename);
        let rawUser;
        try {
            rawUser = fs.readFileSync(filePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') console.error(`Could not read user ${normalized}:`, error);
            rawUser = null;
        }

        try {
            if (rawUser === null) throw new Error('Primary user record is unavailable');
            const user = JSON.parse(rawUser);
            if (!user || typeof user !== 'object' || !user.username) throw new Error('Invalid user record');
            this.users[normalized] = user;
        } catch {
            const recovered = readRecoveryCopy(usersPath, filename, value => Boolean(value?.username));
            if (!recovered) return;

            const user = JSON.parse(recovered);
            this.users[normalized] = user;
            saveMapToFolder({ [filename]: user }, usersPath);
            console.warn(`Recovered user ${filename} from a redundant copy.`);
        }
    }

    offloadUser(username) {
        const normalized = normalizeUsername(username);
        const user = normalized && this.users[normalized];
        if (!user) return false;

        clearTimeout(this.offloadTimers[normalized]);
        delete this.offloadTimers[normalized];
        if (!saveMapToFolder({ [normalized]: user }, usersPath)) return false;
        delete this.users[normalized];
        return true;
    }

    persistUser(username) {
        const normalized = normalizeUsername(username);
        const user = normalized && this.findUser(normalized);
        return Boolean(user) && saveMapToFolder({ [normalized]: user }, usersPath);
    }

    newProject(owner, projectId) {
        const user = this.getUser(owner);
        if (!user) return false;

        const id = String(projectId);
        if (!user.myProjects.map(String).includes(id)) user.myProjects.push(id);
        return true;
    }

    share(username, projectId, owner) {
        const user = this.getUser(username);
        if (!user) return false;

        const id = String(projectId);
        if (!user.sharedTo || typeof user.sharedTo !== 'object') user.sharedTo = {};
        if (!user.sharedTo[id]) user.sharedTo[id] = { from: normalizeUsername(owner), id };
        return true;
    }

    unShare(username, projectId) {
        const user = this.getUser(username);
        if (!user) return false;

        const id = String(projectId);
        delete user.sharedTo?.[id];
        const ownedIndex = user.myProjects.map(String).indexOf(id);
        if (ownedIndex !== -1) user.myProjects.splice(ownedIndex, 1);
        return true;
    }

    getSharedObjects(username) {
        const sharedTo = this.getUser(username)?.sharedTo;
        return sharedTo && typeof sharedTo === 'object' ? Object.values(sharedTo) : [];
    }

    getShared(username) {
        const user = this.getUser(username);
        if (!user) return [];

        const friends = new Set(user.friends.map(normalizeUsername).filter(Boolean));
        return this.getSharedObjects(username)
            .filter(project => friends.has(normalizeUsername(project.from)))
            .map(project => String(project.id));
    }

    getAllProjects(username) {
        const user = this.getUser(username);
        if (!user) return [];
        return [...new Set([...user.myProjects, ...this.getShared(username)].map(String))];
    }
}
