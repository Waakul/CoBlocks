import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';

const recentPath = 'storage/recent.json';
const retentionMs = 30 * 24 * 60 * 60 * 1000;

function loadRecentData() {
    try {
        return JSON.parse(fs.readFileSync(recentPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not load recent user data:', error);
        return {};
    }
}

const stored = loadRecentData();
let recent = stored.recent || {};
let recentRealtime = stored.recentRealtime || {};
let recentShared = stored.recentShared || {};
let popup = Array.isArray(stored.popup) ? stored.popup : [];

function normalizeUsername(username) {
    return typeof username === 'string' ? username.toLowerCase() : null;
}

function countSince(records, days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return Object.values(records).filter(timestamp => timestamp > cutoff).length;
}

function trimRecordMap(records, cutoff) {
    return Object.fromEntries(
        Object.entries(records).filter(([, timestamp]) => timestamp >= cutoff),
    );
}

function trimRecent() {
    const cutoff = Date.now() - retentionMs;
    recent = trimRecordMap(recent, cutoff);
    recentRealtime = trimRecordMap(recentRealtime, cutoff);
    recentShared = trimRecordMap(recentShared, cutoff);
    popup = popup.filter(record => record.t >= cutoff);
}

let jobsInstalled = false;

export function installRecentDataJobs() {
    if (jobsInstalled) return;
    jobsInstalled = true;

    cron.schedule('0 1 * * *', trimRecent, {
        scheduled: true,
        timezone: 'Asia/Qatar',
    });

    const saveInterval = setInterval(() => {
        saveRecent().catch(error => console.error('Could not save recent user data:', error));
    }, 30_000);
    saveInterval.unref();
}

export async function saveRecent() {
    await fsp.mkdir(path.dirname(recentPath), { recursive: true });
    const temporary = `${recentPath}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify({ recent, recentRealtime, recentShared, popup }));
    try {
        await fsp.rename(temporary, recentPath);
    } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

export function recordPopup(username) {
    const normalized = normalizeUsername(username);
    if (normalized) popup.push({ u: normalized, t: Date.now() });
}

export function countPopup(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return popup.filter(record => record.t > cutoff).length;
}

export function countUniquePopup(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return new Set(popup.filter(record => record.t > cutoff).map(record => record.u)).size;
}

export function addRecent(username, realtime, shared) {
    const normalized = normalizeUsername(username);
    if (!normalized) return;

    const now = Date.now();
    recent[normalized] = now;
    if (realtime) recentRealtime[normalized] = now;
    if (shared) recentShared[normalized] = now;
}

export function countRecentShared(days) {
    return countSince(recentShared, days);
}

export function countRecentRealtime(days) {
    return countSince(recentRealtime, days);
}

export function countRecent(days) {
    return countSince(recent, days);
}

export function countRecentBoth(days) {
    return {
        all: countRecent(days),
        realtime: countRecentRealtime(days),
        shared: countRecentShared(days),
    };
}
