import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Scratch Auth integration: https://auth.itinerary.eu.org/documentation/using-scratch-auth
const SCRATCH_AUTH = 'https://auth.itinerary.eu.org';
const API_PREFIX = '/apiv2';
const pending = new Map();
const TTL = 5 * 60_000;
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
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

function createToken() {
    return randomBytes(32).toString('hex');
}

function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
}

function sessionExpiry(user, token) {
    return user.authSessions?.[tokenHash(token)]?.expiresAt ?? user.tokenExpiresAt;
}

async function verifyPrivateCode(privateCode) {
    const url = new URL('/api/auth/verifyToken', SCRATCH_AUTH);
    url.searchParams.set('privateCode', privateCode);
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(`Scratch Auth returned ${response.status}`);
        return await response.json();
    } catch (cause) {
        const error = new Error('Scratch Auth provider verification failed.', { cause });
        error.providerFailure = true;
        throw error;
    }
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
        loginUrl.searchParams.set('name', 'CoBlocks');
        res.json({ state, url: loginUrl.href });
    });

    app.get('/auth/scratch/callback', async (req, res) => {
        const item = pending.get(req.query.state);
        if (!item || Date.now() - item.createdAt > TTL || item.status !== 'waiting') return res.status(400).send('This login expired. Please start again from CoBlocks.');
        if (typeof req.query.privateCode !== 'string' || !req.query.privateCode) return res.status(400).send('Scratch Auth did not complete the CoBlocks login.');
        item.status = 'verifying';
        try {
            const data = await verifyPrivateCode(req.query.privateCode);
            if (data.valid !== true || data.redirect !== item.redirect || !validUsername(data.username)) {
                pending.delete(req.query.state);
                return res.status(403).send('Scratch Auth could not verify this CoBlocks login.');
            }
            const user = userManager.getUser(data.username);
            user.verified = true;
            if (!userManager.persistUser(data.username)) throw new Error('Could not save authenticated user');
            item.status = 'complete';
            item.username = data.username;
            res.redirect(303, `${API_PREFIX}/auth/scratch/complete?state=${req.query.state}`);
        } catch (error) {
            pending.delete(req.query.state);
            console.error('Scratch Auth verification failed:', error);
            res.status(503).send(error.providerFailure
                ? 'CoBlocks could not reach Scratch Auth. Please try again.'
                : 'CoBlocks could not finish the login. Check the backend log and try again.');
        }
    });

    app.get('/auth/scratch/complete', (req, res) => {
        const item = pending.get(req.query.state);
        if (!item || item.status !== 'complete') return res.status(400).send('This CoBlocks login is incomplete or expired.');
        res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>CoBlocks login</title></head><body style="font:16px system-ui;max-width:35rem;margin:4rem auto;padding:1rem"><h1>Finishing CoBlocks sign-in</h1><p>Keep this tab open while the extension saves your login. You will be redirected when it is ready.</p></body></html>');
    });

    app.post('/auth/scratch/finish', (req, res) => {
        const item = pending.get(req.body?.state);
        if (!item || item.status !== 'complete' || Date.now() - item.createdAt > TTL) return res.status(400).json({ err: 'Login is incomplete or expired.' });
        const user = userManager.findUser(item.username);
        if (!user?.verified) return res.status(403).json({ err: 'Please sign in again.' });
        const token = createToken();
        const now = Date.now();
        const expiresAt = now + SESSION_LIFETIME_MS;
        const previousSessions = user.authSessions;
        user.authSessions = Object.fromEntries(Object.entries(previousSessions || {}).filter(([, session]) => session && Number.isFinite(session.expiresAt) && session.expiresAt > now));
        user.authSessions[tokenHash(token)] = { createdAt: now, expiresAt };
        if (!userManager.persistUser(item.username)) {
            user.authSessions = previousSessions;
            return res.status(500).json({ err: 'Could not save the login session. Please try again.' });
        }
        pending.delete(req.body.state);
        res.json({ username: user.username, token, expiresAt });
    });

    app.post('/auth/session', (req, res) => {
        const username = req.body?.username;
        if (!authenticate(username, req.headers.authorization)) {
            return res.status(401).json({ noauth: true });
        }
        const user = userManager.findUser(username);
        res.json({ username: user.username, expiresAt: sessionExpiry(user, req.headers.authorization) });
    });

    app.post('/auth/logout', (req, res) => {
        const username = req.body?.username;
        if (!authenticate(username, req.headers.authorization)) return res.status(401).json({ err: 'Invalid login.' });
        const user = userManager.findUser(username);
        const previousSessions = user.authSessions;
        const previousToken = user.token;
        const previousExpiry = user.tokenExpiresAt;
        user.authSessions = { ...previousSessions };
        delete user.authSessions[tokenHash(req.headers.authorization)];
        if (user.token === req.headers.authorization) {
            user.token = createToken();
            user.tokenExpiresAt = 0;
        }
        if (!userManager.persistUser(username)) {
            user.authSessions = previousSessions;
            user.token = previousToken;
            user.tokenExpiresAt = previousExpiry;
            return res.status(500).json({ err: 'Could not save logout.' });
        }
        res.status(204).send();
    });
}

export function authenticate(username, token) {
    if (!validUsername(username) || typeof token !== 'string' || !token || token.length > 256) return false;
    const user = userManager.findUser(username);
    if (!user?.verified) return false;
    const session = user.authSessions?.[tokenHash(token)];
    if (session) return Number.isFinite(session.expiresAt) && Date.now() < session.expiresAt;
    // Give existing installations a bounded migration period without forcing a logout.
    if (typeof user.token !== 'string') return false;
    const expected = Buffer.from(user.token);
    const supplied = Buffer.from(token);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    if (user.tokenExpiresAt === undefined) {
        user.tokenExpiresAt = Date.now() + SESSION_LIFETIME_MS;
        if (!userManager.persistUser(username)) {
            delete user.tokenExpiresAt;
            return false;
        }
    }
    return Number.isFinite(user.tokenExpiresAt) && Date.now() < user.tokenExpiresAt;
}

export function fullAuthenticate(username, token, lsId) {
    if (token) numWithCreds++; else numWithoutCreds++;
    if (!authenticate(username, token) || !lsId) return false;
    return admins.includes(username.toLowerCase()) || sessionManager.canUserAccessProject(username, lsId);
}
