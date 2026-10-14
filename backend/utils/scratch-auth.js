import { randomBytes, timingSafeEqual } from 'node:crypto';

// Scratch Auth integration: https://auth.itinerary.eu.org/documentation/using-scratch-auth
const SCRATCH_AUTH = 'https://auth.itinerary.eu.org';
const API_PREFIX = '/apiv2';
const pending = new Map();
const TTL = 5 * 60_000;
const attempts = new Map();
let userManager;
let sessionManager;
const admins = JSON.parse(process.env.ADMIN || '[]').map(name => name.toLowerCase());

export const failedAuthLog = {};
export const secondTimeSuccessAuthLog = {};
export let numWithCreds = 0;
export let numWithoutCreds = 0;

function validUsername(username) {
    return typeof username === 'string' && /^[a-zA-Z0-9_-]{3,20}$/.test(username);
}

function publicBaseUrl() {
    const raw = process.env.PUBLIC_BASE_URL || 'https://livescratchapi.waakul.com';
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
        const cleanPath = url.pathname.replace(/\/$/, '');
        url.pathname = cleanPath.endsWith(API_PREFIX) ? cleanPath : `${cleanPath}${API_PREFIX}`;
        return url.href.replace(/\/$/, '');
    } catch { return null; }
}

function sweep() {
    for (const [state, item] of pending) if (Date.now() - item.createdAt > TTL) pending.delete(state);
    for (const [ip, item] of attempts) if (Date.now() - item.start > 60_000) attempts.delete(ip);
}

export function getAuthStats() {
    return { pending: pending.size, failed: Object.keys(failedAuthLog).length };
}

export function setPaths(app, users, sessions) {
    userManager = users;
    sessionManager = sessions;

    app.post('/auth/scratch/start', (req, res) => {
        sweep();
        const base = publicBaseUrl();
        if (!base) return res.status(503).json({ err: 'Invalid PUBLIC_BASE_URL configuration.' });
        const ip = req.ip;
        const bucket = attempts.get(ip) || { count: 0, start: Date.now() };
        if (bucket.count >= 5) return res.status(429).json({ err: 'Too many login attempts. Try again in a minute.' });
        bucket.count++;
        attempts.set(ip, bucket);
        const state = randomBytes(32).toString('hex');
        const redirect = `${base}/auth/scratch/callback?state=${state}`;
        pending.set(state, { redirect, createdAt: Date.now(), status: 'waiting' });
        const loginUrl = new URL('/auth/', SCRATCH_AUTH);
        loginUrl.searchParams.set('redirect', Buffer.from(redirect).toString('base64'));
        loginUrl.searchParams.set('name', 'LiveScratch');
        res.json({ state, url: loginUrl.href });
    });

    app.get('/auth/scratch/callback', async (req, res) => {
        const item = pending.get(req.query.state);
        if (!item || Date.now() - item.createdAt > TTL || item.status !== 'waiting') return res.status(400).send('This login expired. Please start again from LiveScratch.');
        if (typeof req.query.privateCode !== 'string' || !req.query.privateCode) return res.status(400).send('Scratch Auth did not complete the login.');
        item.status = 'verifying';
        try {
            const url = new URL('/api/auth/verifyToken', SCRATCH_AUTH);
            url.searchParams.set('privateCode', req.query.privateCode);
            const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`Scratch Auth returned ${response.status}`);
            const data = await response.json();
            if (data.valid !== true || data.redirect !== item.redirect || !validUsername(data.username)) {
                pending.delete(req.query.state);
                return res.status(403).send('Scratch Auth could not verify this login.');
            }
            const user = userManager.getUser(data.username);
            user.verified = true;
            user.token = userManager.token();
            if (!userManager.persistUser(data.username)) throw new Error('Could not save authenticated user');
            item.status = 'complete';
            item.username = data.username;
            item.token = user.token;
            res.redirect(303, `${API_PREFIX}/auth/scratch/complete?state=${req.query.state}`);
        } catch (error) {
            pending.delete(req.query.state);
            console.error('Scratch Auth verification failed:', error);
            res.status(503).send('Scratch Auth is temporarily unavailable. Please try again.');
        }
    });

    app.get('/auth/scratch/complete', (req, res) => {
        const item = pending.get(req.query.state);
        if (!item || item.status !== 'complete') return res.status(400).send('This login is incomplete or expired.');
        res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>LiveScratch login</title></head><body style="font:16px system-ui;max-width:35rem;margin:4rem auto;padding:1rem"><h1>Signed in to LiveScratch</h1><p>You can close this tab and return to Scratch.</p></body></html>');
    });

    app.post('/auth/scratch/finish', (req, res) => {
        const item = pending.get(req.body?.state);
        if (!item || item.status !== 'complete' || Date.now() - item.createdAt > TTL) return res.status(400).json({ err: 'Login is incomplete or expired.' });
        pending.delete(req.body.state);
        const user = userManager.findUser(item.username);
        if (!user?.verified || !authenticate(item.username, item.token)) return res.status(403).json({ err: 'Login was replaced by a newer sign in. Please try again.' });
        res.json({ username: user.username, token: item.token });
    });

    app.post('/auth/logout', (req, res) => {
        const username = req.body?.username;
        if (!authenticate(username, req.headers.authorization)) return res.status(401).json({ err: 'Invalid login.' });
        const user = userManager.findUser(username);
        user.verified = false;
        user.token = userManager.token();
        if (!userManager.persistUser(username)) return res.status(500).json({ err: 'Could not save logout.' });
        res.status(204).send();
    });
}

export function authenticate(username, token) {
    if (!validUsername(username) || typeof token !== 'string' || !token) return false;
    const user = userManager.findUser(username);
    if (!user?.verified || typeof user.token !== 'string') return false;
    const expected = Buffer.from(user.token);
    const supplied = Buffer.from(token);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function fullAuthenticate(username, token, lsId) {
    if (token) numWithCreds++; else numWithoutCreds++;
    if (!authenticate(username, token) || !lsId) return false;
    return admins.includes(username.toLowerCase()) || sessionManager.canUserAccessProject(username, lsId);
}
