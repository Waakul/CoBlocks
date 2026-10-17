import test from 'node:test';
import assert from 'node:assert/strict';
import { setPaths, authenticate, fullAuthenticate, SESSION_LIFETIME_MS } from '../utils/scratch-auth.js';

function response() {
    return {
        statusCode: 200, body: null, headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        type() { return this; },
        redirect(code, url) { this.statusCode = code; this.headers.location = url; return this; },
    };
}

test('Scratch Auth issues a persistent 30-day CoBlocks session through a one-time handoff', async () => {
    process.env.PUBLIC_BASE_URL = 'https://livescratchapi.waakul.com';
    const routes = new Map();
    const app = {
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); },
    };
    const users = new Map();
    const userManager = {
        getUser(username) {
            const key = username.toLowerCase();
            if (!users.has(key)) users.set(key, { username, token: 'test-secret', verified: false });
            return users.get(key);
        },
        findUser(username) { return users.get(username.toLowerCase()); },
        persistUser() { return true; },
    };
    setPaths(app, userManager, { canUserAccessProject: (_username, id) => id === 'owned' });
    assert.equal(authenticate('Alice', 'test-secret'), false);
    assert.equal(authenticate(undefined, 'test-secret'), false);
    assert.equal(authenticate('Alice', undefined), false);
    assert.equal(authenticate('Alice', ''), false);
    assert.equal(fullAuthenticate('Alice', 'test-secret', 'owned'), false);

    const start = response();
    routes.get('POST /auth/scratch/start')({ ip: 'test', body: {} }, start);
    assert.equal(start.statusCode, 200);
    const { state, url } = start.body;
    assert.equal(new URL(url).searchParams.get('name'), 'CoBlocks');
    const redirect = Buffer.from(new URL(url).searchParams.get('redirect'), 'base64').toString();
    assert.equal(redirect, `https://livescratchapi.waakul.com/apiv2/auth/scratch/callback?state=${state}`);

    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, username: 'Alice', redirect }) });
    try {
        const callback = response();
        await routes.get('GET /auth/scratch/callback')({ query: { state, privateCode: 'provider-code' } }, callback);
        assert.equal(callback.statusCode, 303);
        assert.equal(callback.headers.location, `/apiv2/auth/scratch/complete?state=${state}`);

        const finish = response();
        routes.get('POST /auth/scratch/finish')({ body: { state } }, finish);
        assert.equal(finish.body.username, 'Alice');
        const storedSessions = Object.values(users.get('alice').authSessions);
        assert.equal(storedSessions[0].expiresAt - storedSessions[0].createdAt, SESSION_LIFETIME_MS);
        assert.equal(finish.body.expiresAt, storedSessions[0].expiresAt);
        assert.equal(JSON.stringify(users.get('alice').authSessions).includes(finish.body.token), false);
        users.set('alice', JSON.parse(JSON.stringify(users.get('alice'))));
        assert.equal(authenticate('Alice', finish.body.token), true);
        assert.equal(authenticate('Mallory', finish.body.token), false);
        assert.equal(fullAuthenticate('Alice', finish.body.token, 'owned'), true);
        assert.equal(fullAuthenticate('Alice', finish.body.token, 'other'), false);

        const session = response();
        routes.get('POST /auth/session')({ body: { username: 'Alice' }, headers: { authorization: finish.body.token } }, session);
        assert.equal(session.statusCode, 200);
        assert.equal(session.body.username, 'Alice');
        assert.equal(session.body.expiresAt, finish.body.expiresAt);

        const differentlyCasedSession = response();
        routes.get('POST /auth/session')({ body: { username: 'aLiCe' }, headers: { authorization: finish.body.token } }, differentlyCasedSession);
        assert.equal(differentlyCasedSession.statusCode, 200);
        assert.equal(differentlyCasedSession.body.username, 'Alice');

        const wrongAccount = response();
        routes.get('POST /auth/session')({ body: { username: 'Mallory' }, headers: { authorization: finish.body.token } }, wrongAccount);
        assert.equal(wrongAccount.statusCode, 401);
        assert.equal(wrongAccount.body.noauth, true);

        const replay = response();
        routes.get('POST /auth/scratch/finish')({ body: { state } }, replay);
        assert.equal(replay.statusCode, 400);

        const logout = response();
        routes.get('POST /auth/logout')({ body: { username: 'Alice' }, headers: { authorization: finish.body.token } }, logout);
        assert.equal(logout.statusCode, 204);
        assert.equal(authenticate('Alice', finish.body.token), false);
    } finally { global.fetch = originalFetch; }
});

test('Scratch Auth rejects a result for a different redirect', async () => {
    const routes = new Map();
    const app = {
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); },
    };
    const users = { getUser() { throw new Error('must not create user'); }, findUser() { return null; } };
    setPaths(app, users, { canUserAccessProject() { return false; } });
    const start = response();
    routes.get('POST /auth/scratch/start')({ ip: 'test2', body: {} }, start);
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, username: 'Alice', redirect: 'https://attacker.example/callback' }) });
    try {
        const callback = response();
        await routes.get('GET /auth/scratch/callback')({ query: { state: start.body.state, privateCode: 'provider-code' } }, callback);
        assert.equal(callback.statusCode, 403);
    } finally { global.fetch = originalFetch; }
});

test('parallel sign-ins receive independent sessions and logout revokes only one', async () => {
    process.env.PUBLIC_BASE_URL = 'https://livescratchapi.waakul.com';
    const routes = new Map();
    const app = {
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); },
    };
    const users = new Map();
    const manager = {
        getUser(username) {
            const key = username.toLowerCase();
            if (!users.has(key)) users.set(key, { username, verified: false, token: '' });
            return users.get(key);
        },
        findUser(username) { return users.get(username.toLowerCase()); },
        persistUser() { return true; },
    };
    setPaths(app, manager, { canUserAccessProject() { return true; } });

    const firstStart = response();
    const secondStart = response();
    routes.get('POST /auth/scratch/start')({ ip: 'parallel-login', body: {} }, firstStart);
    routes.get('POST /auth/scratch/start')({ ip: 'parallel-login', body: {} }, secondStart);
    const redirects = new Map([
        ['first', Buffer.from(new URL(firstStart.body.url).searchParams.get('redirect'), 'base64').toString()],
        ['second', Buffer.from(new URL(secondStart.body.url).searchParams.get('redirect'), 'base64').toString()],
    ]);
    const originalFetch = global.fetch;
    global.fetch = async url => {
        const code = new URL(url).searchParams.get('privateCode');
        return { ok: true, json: async () => ({ valid: true, username: 'Alice', redirect: redirects.get(code) }) };
    };
    try {
        await routes.get('GET /auth/scratch/callback')({ query: { state: firstStart.body.state, privateCode: 'first' } }, response());
        await routes.get('GET /auth/scratch/callback')({ query: { state: secondStart.body.state, privateCode: 'second' } }, response());

        const staleFinish = response();
        routes.get('POST /auth/scratch/finish')({ body: { state: firstStart.body.state } }, staleFinish);
        assert.equal(staleFinish.statusCode, 200);

        const currentFinish = response();
        routes.get('POST /auth/scratch/finish')({ body: { state: secondStart.body.state } }, currentFinish);
        assert.match(currentFinish.body.token, /^[a-f0-9]{64}$/);
        assert.equal(authenticate('Alice', currentFinish.body.token), true);
        assert.notEqual(staleFinish.body.token, currentFinish.body.token);
        const logout = response();
        routes.get('POST /auth/logout')({ body: { username: 'Alice' }, headers: { authorization: staleFinish.body.token } }, logout);
        assert.equal(logout.statusCode, 204);
        assert.equal(authenticate('Alice', staleFinish.body.token), false);
        assert.equal(authenticate('Alice', currentFinish.body.token), true);
        const originalNow = Date.now;
        try {
            Date.now = () => currentFinish.body.expiresAt - 1;
            assert.equal(authenticate('Alice', currentFinish.body.token), true);
            Date.now = () => currentFinish.body.expiresAt;
            assert.equal(authenticate('Alice', currentFinish.body.token), false);
        } finally { Date.now = originalNow; }
    } finally { global.fetch = originalFetch; }
});


test('legacy tokens migrate once to a fixed 30-day expiry', () => {
    const user = { username: 'Alice', token: 'legacy-token', verified: true };
    let writes = 0;
    const manager = { findUser: () => user, persistUser: () => { writes++; return true; } };
    setPaths({ get() {}, post() {} }, manager, { canUserAccessProject: () => true });
    const originalNow = Date.now;
    try {
        Date.now = () => 1000;
        assert.equal(authenticate('Alice', 'wrong-token'), false);
        assert.equal(writes, 0);
        assert.equal(authenticate('Alice', 'legacy-token'), true);
        const expiresAt = 1000 + SESSION_LIFETIME_MS;
        assert.equal(user.tokenExpiresAt, expiresAt);
        Date.now = () => expiresAt - 1;
        assert.equal(authenticate('Alice', 'legacy-token'), true);
        assert.equal(user.tokenExpiresAt, expiresAt);
        assert.equal(writes, 1);
        Date.now = () => expiresAt;
        assert.equal(authenticate('Alice', 'legacy-token'), false);
    } finally { Date.now = originalNow; }
});

test('a provider timeout allows retrying the same pending login', async () => {
    const routes = new Map();
    const user = { username: 'Alice', verified: false };
    setPaths({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
    }, {
        getUser: () => user,
        findUser: () => user,
        persistUser: () => true,
    }, { canUserAccessProject: () => true });
    const start = response();
    routes.get('POST /auth/scratch/start')({ ip: 'provider-timeout-test' }, start);
    const redirect = Buffer.from(new URL(start.body.url).searchParams.get('redirect'), 'base64').toString();
    const originalFetch = global.fetch;
    const originalError = console.error;
    console.error = () => {};
    global.fetch = async () => { throw new global.DOMException('Timed out', 'TimeoutError'); };
    try {
        const failed = response();
        const request = { query: { state: start.body.state, privateCode: 'provider-code' } };
        await routes.get('GET /auth/scratch/callback')(request, failed);
        assert.equal(failed.statusCode, 503);
        assert.match(failed.body, /Refresh this page/);
        assert.equal(user.verified, false);
        global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, username: 'Alice', redirect }) });
        const retried = response();
        await routes.get('GET /auth/scratch/callback')(request, retried);
        assert.equal(retried.statusCode, 303);
        assert.equal(user.verified, true);
    } finally {
        global.fetch = originalFetch;
        console.error = originalError;
    }
});
