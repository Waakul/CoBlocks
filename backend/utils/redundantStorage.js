import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sanitize from 'sanitize-filename';

export const DEFAULT_REDUNDANCY_ROOT = 'storage-redundancy';
export const DEFAULT_SNAPSHOT_LIMIT = 8;

const cleanKey = key => sanitize(String(key));

function atomicWrite(filename, contents) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, contents);
        fs.renameSync(temporary, filename);
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* ignored */ }
        throw error;
    }
}

function validJson(contents, validator) {
    if (typeof contents !== 'string' && !Buffer.isBuffer(contents)) return false;
    try {
        const parsed = JSON.parse(contents);
        return typeof validator === 'function' ? !!validator(parsed) : true;
    } catch {
        return false;
    }
}

function recordPaths(kind, key, root = DEFAULT_REDUNDANCY_ROOT) {
    const safeKind = cleanKey(kind);
    const safeKey = cleanKey(key);
    if (!safeKind || !safeKey) return null;
    return {
        mirror: path.join(root, 'mirrors', safeKind, safeKey),
        snapshots: path.join(root, 'snapshots', safeKind, safeKey),
    };
}

function pruneSnapshots(directory, limit) {
    if (!fs.existsSync(directory)) return;
    const files = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()
        .reverse();
    files.slice(limit).forEach(filename => fs.rmSync(path.join(directory, filename), { force: true }));
}

export function writeRedundantJson(kind, key, contents, options = {}) {
    const paths = recordPaths(kind, key, options.root);
    if (!paths || !validJson(contents)) return false;
    const serialized = Buffer.isBuffer(contents) ? contents.toString('utf8') : contents;
    let previous = null;
    try { previous = fs.readFileSync(paths.mirror, 'utf8'); } catch { /* first write */ }

    atomicWrite(paths.mirror, serialized);
    if (previous !== serialized) {
        const timestamp = `${String(Date.now()).padStart(13, '0')}-${randomUUID()}.json`;
        atomicWrite(path.join(paths.snapshots, timestamp), serialized);
        pruneSnapshots(paths.snapshots, options.snapshotLimit || DEFAULT_SNAPSHOT_LIMIT);
    }
    return true;
}

export function readRedundantJson(kind, key, options = {}) {
    const paths = recordPaths(kind, key, options.root);
    if (!paths) return null;
    try {
        const mirror = fs.readFileSync(paths.mirror, 'utf8');
        if (validJson(mirror, options.validator)) return mirror;
    } catch { /* try snapshots */ }

    if (!fs.existsSync(paths.snapshots)) return null;
    const snapshots = fs.readdirSync(paths.snapshots, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()
        .reverse();
    for (const snapshot of snapshots) {
        try {
            const contents = fs.readFileSync(path.join(paths.snapshots, snapshot), 'utf8');
            if (validJson(contents, options.validator)) {
                atomicWrite(paths.mirror, contents);
                return contents;
            }
        } catch { /* try an older generation */ }
    }
    return null;
}

export function deleteRedundantJson(kind, key, options = {}) {
    const paths = recordPaths(kind, key, options.root);
    if (!paths) return false;
    fs.rmSync(paths.mirror, { force: true });
    fs.rmSync(paths.snapshots, { recursive: true, force: true });
    return true;
}

export function recoverFileFromRedundancy(filename, kind, key, options = {}) {
    try {
        const primary = fs.readFileSync(filename, 'utf8');
        if (validJson(primary, options.validator)) return primary;
    } catch { /* recover below */ }

    const recovered = readRedundantJson(kind, key, options);
    if (!recovered) return null;
    atomicWrite(filename, recovered);
    return recovered;
}

export function listRedundantKeys(kind, options = {}) {
    const root = options.root || DEFAULT_REDUNDANCY_ROOT;
    const mirrorDirectory = path.join(root, 'mirrors', cleanKey(kind));
    const snapshotDirectory = path.join(root, 'snapshots', cleanKey(kind));
    const keys = new Set();
    if (fs.existsSync(mirrorDirectory)) {
        fs.readdirSync(mirrorDirectory, { withFileTypes: true })
            .filter(entry => entry.isFile() && cleanKey(entry.name) === entry.name)
            .forEach(entry => keys.add(entry.name));
    }
    if (fs.existsSync(snapshotDirectory)) {
        fs.readdirSync(snapshotDirectory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && cleanKey(entry.name) === entry.name)
            .forEach(entry => keys.add(entry.name));
    }
    return [...keys];
}

export function seedAndRecoverDirectory(primaryDirectory, kind, options = {}) {
    fs.mkdirSync(primaryDirectory, { recursive: true });
    let recovered = 0;
    let seeded = 0;

    for (const key of listRedundantKeys(kind, options)) {
        const filename = path.join(primaryDirectory, key);
        let primaryValid = false;
        try { primaryValid = validJson(fs.readFileSync(filename)); } catch { /* missing */ }
        if (!primaryValid && recoverFileFromRedundancy(filename, kind, key, options)) recovered++;
    }

    for (const entry of fs.readdirSync(primaryDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || cleanKey(entry.name) !== entry.name || entry.name.endsWith('.tmp')) continue;
        try {
            const contents = fs.readFileSync(path.join(primaryDirectory, entry.name), 'utf8');
            if (validJson(contents) && writeRedundantJson(kind, entry.name, contents, options)) seeded++;
        } catch { /* retain damaged primary for manual inspection */ }
    }
    return { recovered, seeded };
}
