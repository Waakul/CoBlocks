import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import sanitize from 'sanitize-filename';

import { saveRecent } from './recentUsers.js';
import {
    deleteRedundantJson,
    readRedundantJson,
    seedAndRecoverDirectory,
    writeRedundantJson,
} from './redundantStorage.js';

export const projectStoragePath = 'storage/sessions/livescratch';
export const projectLinksPath = 'storage/sessions/scratchprojects';
export const lastIdPath = 'storage/sessions/lastId';
export const usersPath = 'storage/users';
export const bannedPath = 'storage/banned';

const MAX_JSON_LENGTH = 51_428_000;
const SAVE_INTERVAL_MS = 30_000;

for (const directory of [projectStoragePath, projectLinksPath, usersPath]) {
    fs.mkdirSync(directory, { recursive: true });
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function recoveryKind(directory) {
    const resolved = path.resolve(directory);
    if (resolved === path.resolve(projectStoragePath)) return 'projects';
    if (resolved === path.resolve(projectLinksPath)) return 'scratchprojects';
    if (resolved === path.resolve(usersPath)) return 'users';
    return null;
}

function serializeEntry(key, value) {
    const filename = sanitize(String(key));
    const json = JSON.stringify(value);
    if (!filename || json.length > MAX_JSON_LENGTH) return null;
    return { filename, json };
}

function saveRecoveryCopy(directory, filename, json) {
    const kind = recoveryKind(directory);
    if (kind && !writeRedundantJson(kind, filename, json)) {
        throw new Error(`Could not create recovery copy for ${kind}/${filename}`);
    }
}

export function initializeStorageRecovery() {
    const projects = seedAndRecoverDirectory(projectStoragePath, 'projects');
    const scratchprojects = seedAndRecoverDirectory(projectLinksPath, 'scratchprojects');
    const users = seedAndRecoverDirectory(usersPath, 'users');
    const recovered = projects.recovered + scratchprojects.recovered + users.recovered;
    if (recovered) console.warn(`Recovered ${recovered} storage record(s) from redundant copies.`);
    return { projects, scratchprojects, users };
}

export function readRecoveryCopy(directory, key, validator) {
    const kind = recoveryKind(directory);
    return kind ? readRedundantJson(kind, key, { validator }) : null;
}

export function deleteRecoveryCopies(directory, key) {
    const kind = recoveryKind(directory);
    return kind ? deleteRedundantJson(kind, key) : false;
}

function readBannedList() {
    try {
        return fs.readFileSync(bannedPath, 'utf8')
            .split('\n')
            .map(username => username.trim())
            .filter(Boolean);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

export function saveMapToFolder(records, directory) {
    if (!records) {
        console.error(`Cannot save an empty record map to ${directory}.`);
        return false;
    }

    fs.mkdirSync(directory, { recursive: true });
    let success = true;

    for (const [key, value] of Object.entries(records)) {
        const entry = serializeEntry(key, value);
        if (!entry) {
            console.error(`Skipped invalid or oversized record: ${key}`);
            success = false;
            continue;
        }

        const destination = path.join(directory, entry.filename);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, entry.json);
            fs.renameSync(temporary, destination);
            saveRecoveryCopy(directory, entry.filename, entry.json);
        } catch (error) {
            try {
                fs.rmSync(temporary, { force: true });
            } catch {
                // The original write error is more useful than cleanup failure details.
            }
            console.error(`Could not save ${destination}:`, error);
            success = false;
        }
    }

    return success;
}

export async function saveMapToFolderAsync(records, directory) {
    if (!records) {
        console.error(`Cannot save an empty record map to ${directory}.`);
        return false;
    }

    await fsp.mkdir(directory, { recursive: true });
    let success = true;

    for (const [key, value] of Object.entries(records)) {
        const entry = serializeEntry(key, value);
        if (!entry) {
            console.error(`Skipped invalid or oversized record: ${key}`);
            success = false;
            continue;
        }

        const destination = path.join(directory, entry.filename);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            await fsp.writeFile(temporary, entry.json);
            await fsp.rename(temporary, destination);
            saveRecoveryCopy(directory, entry.filename, entry.json);
        } catch (error) {
            await fsp.rm(temporary, { force: true }).catch(() => {});
            console.error(`Could not save ${destination}:`, error);
            success = false;
        }
    }

    return success;
}

export function loadMapFromFolder(directory) {
    if (!fs.existsSync(directory)) return {};

    const records = {};
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filename = path.join(directory, entry.name);
        try {
            records[entry.name] = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch (error) {
            console.error(`Could not parse JSON file ${filename}:`, error.message);
        }
    }
    return records;
}

export function loadMapFromFolderRecursive(directory) {
    if (!fs.existsSync(directory)) return {};

    const records = {};
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            records[entry.name] = loadMapFromFolderRecursive(entryPath);
            continue;
        }
        if (!entry.isFile()) continue;

        try {
            records[entry.name] = entry.name === 'banned'
                ? readBannedList()
                : JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        } catch (error) {
            console.error(`Could not parse JSON file ${entryPath}:`, error.message);
        }
    }
    return records;
}

export async function saveLoop(isFinalSaving = () => false) {
    while (true) {
        if (!isFinalSaving()) {
            try {
                await saveRecent();
            } catch (error) {
                console.error('Periodic save failed:', error);
            }
        }
        await sleep(SAVE_INTERVAL_MS);
    }
}

export async function ban(username) {
    const banned = readBannedList();
    if (!banned.includes(username)) {
        await fsp.mkdir(path.dirname(bannedPath), { recursive: true });
        await fsp.appendFile(bannedPath, `${username}\n`);
    }
}

export async function unban(username) {
    const updatedList = readBannedList().filter(user => user !== username);
    await fsp.mkdir(path.dirname(bannedPath), { recursive: true });
    await fsp.writeFile(bannedPath, updatedList.join('\n'), 'utf8');
}

export function getBanned(asPromise = true) {
    const banned = readBannedList();
    return asPromise ? Promise.resolve(banned) : banned;
}
