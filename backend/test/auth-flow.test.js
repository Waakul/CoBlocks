import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { setPaths, authenticate, SESSION_LIFETIME_MS } from '../utils/scratch-auth.js';

const authSource = readFileSync(new URL('../../extension/background/auth.js', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const apiUrl = 'https://example.test/apiv2';
let flowSequence = 0;

function response() {
    return {
        statusCode: 200, body: null, headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headers['content-type'] = 'application/json'; return this; },
        send(body) { this.body = body; return this; },
        type() { return this; },
        redirect(code, location) { this.statusCode = code; this.headers.location = location; return this; },
    };
}

function flow(options = {}) {
    const clientIp = `flow-test-${++flowSequence}`;
    process.env.PUBLIC_BASE_URL = 'https://example.test';
    const routes = new Map();
    const users = new Map();
    const alice = { username: 'Alice', verified: true, token: 'old-token', myProjects: ['1'], friends: ['Bob'] };
    users.set('alice', alice);
    setPaths({
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
    }, {
        getUser(username) {
            const key = username.toLowerCase();
            if (!users.has(key)) users.set(key, { username, verified: false });
            return users.get(key);
        },
        findUser: username => users.get(username.toLowerCase()),
        persistUser: () => true,
    }, { canUserAccessProject: () => true });

    const local = { uname: 'Alice', 'lsToken.alice': 'old-token', coblocksAuthUsername: 'Alice' };
    const session = {};
    const storage = data => ({
        get: async keys => {
            const copy = JSON.parse(JSON.stringify(data));
            if (keys === null) return copy;
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, copy[key]]));
        },
        set: async values => Object.assign(data, JSON.parse(JSON.stringify(values))),
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    });
    const messageListeners = [];
    const tabUrls = new Map();
    const requests = [];
    let dropFinishResponse = options.dropFinishResponse;
    let delayedResponse;
    const delayed = new Promise(resolve => { delayedResponse = resolve; });
    const event = { addListener() {} };
    const context = vm.createContext({
        URL, AbortSignal, console, Buffer,
        apiUrl, uname: 'Alice', upk: 1, backgroundReady: Promise.resolve(),
        lastUnameRefresh: 0, usernameRefreshPromise: null, signedin: false,
        getScratchSession: async () => ({ user: { username: 'Alice', id: 1 } }),
        hasScratchSessionCookie: async () => true,
        COBLOCKS: { onAuthenticated() {}, onLoggedOut() {} },
        fetch: async (url, init = {}) => {
            const path = new URL(url).pathname.replace('/apiv2', '');
            requests.push(path);
            if (path === '/delayed') return delayed;
            if (path === '/protected') return new global.Response(JSON.stringify({ noauth: true }), { status: 401, headers: { 'content-type': 'application/json' } });
            const result = response();
            const handler = routes.get(`${init.method || 'GET'} ${path}`);
            assert.ok(handler, `Unexpected endpoint: ${path}`);
            await handler({ ip: clientIp, body: JSON.parse(init.body || '{}'), headers: init.headers || {} }, result);
            if (path === '/auth/scratch/finish' && dropFinishResponse) {
                dropFinishResponse = false;
                throw new TypeError('Connection closed before the token response arrived');
            }
            return new global.Response(result.statusCode === 204 ? null : typeof result.body === 'string' ? result.body : JSON.stringify(result.body), {
                status: result.statusCode, headers: result.headers,
            });
        },
        chrome: {
            storage: { local: storage(local), session: storage(session) },
            cookies: { getAll: async () => [], remove: async () => {} },
            runtime: {
                getURL: path => `chrome-extension://test/${path}`,
                onMessage: { addListener: listener => messageListeners.push(listener) },
                onMessageExternal: event,
            },
            tabs: {
                create: async ({ url }) => { tabUrls.set(10, url); return { id: 10 }; },
                update: async (id, { url }) => { tabUrls.set(id, url); },
                get: async id => ({ id, url: tabUrls.get(id) }),
                onUpdated: event, onRemoved: event,
            },
            webNavigation: { onCommitted: event },
        },
    });
    vm.runInContext(authSource, context);
    vm.runInContext(backgroundSource.slice(backgroundSource.indexOf('    async function refreshUsername(force)'), backgroundSource.indexOf('    chrome.cookies.onChanged.addListener')), context);
    const run = code => vm.runInContext(code, context);
    const message = (meta, sender = { url: 'chrome-extension://test/popups/popup.html' }) => new Promise(resolve => {
        for (const listener of messageListeners) listener({ meta }, sender, resolve);
    });
    const verifyProvider = async (username = 'Alice') => {
        const pending = local.scratchAuthLogin;
        assert.ok(pending, 'The extension must preserve the pending login');
        const originalFetch = global.fetch;
        const redirect = `${apiUrl}/auth/scratch/callback?state=${pending.state}`;
        global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, username, redirect }) });
        try {
            const result = response();
            await routes.get('GET /auth/scratch/callback')({ query: { state: pending.state, privateCode: 'provider-code' } }, result);
            assert.equal(result.statusCode, 303);
            const url = `https://example.test${result.headers.location}`;
            tabUrls.set(10, url);
            return { url, tab: { id: 10 } };
        } finally { global.fetch = originalFetch; }
    };
    return { local, session, users, alice, requests, context, run, message, verifyProvider, tabUrls, delayedResponse };
}

test('full auth flow survives credential rejection during sign-in and repeated completion events', async () => {
    const f = flow();
    assert.equal((await f.message('startScratchAuth')).started, true);
    await f.run("authenticatedFetch(apiUrl + '/protected', { headers: { authorization: currentCoBlocksToken } })");
    assert.ok(f.local.scratchAuthLogin);
    const sender = await f.verifyProvider();
    assert.equal((await f.message('finishScratchAuth', sender)).ok, true);
    const token = f.local['lsToken.alice'];
    assert.notEqual(token, 'old-token');
    assert.equal(authenticate('Alice', token), true);
    assert.equal(f.local.scratchAuthLogin, undefined);
    assert.ok(f.tabUrls.get(10).includes('auth/success.html'));
    assert.equal((await f.message('finishScratchAuth', sender)).ok, true);
    assert.equal(f.requests.filter(path => path === '/auth/scratch/finish').length, 1);
    assert.equal((await f.message('logoutScratchAuth')).success, true);
    assert.equal(authenticate('Alice', token), false);
});

test('a delayed rejection for an old token cannot erase the newly saved session', async () => {
    const f = flow();
    await f.message('startScratchAuth');
    const late = f.run("authenticatedFetch(apiUrl + '/delayed', { headers: { authorization: currentCoBlocksToken } })");
    assert.equal((await f.message('finishScratchAuth', await f.verifyProvider())).ok, true);
    const token = f.local['lsToken.alice'];
    f.delayedResponse(new global.Response(JSON.stringify({ noauth: true }), { headers: { 'content-type': 'application/json' } }));
    await late;
    assert.equal(f.local['lsToken.alice'], token);
    assert.equal(authenticate('Alice', token), true);
});

test('successful sign-in replaces all previous sessions for only that user', async () => {
    const f = flow();
    const otherToken = 'another-valid-device';
    const hash = createHash('sha256').update(otherToken).digest('hex');
    const now = Date.now();
    f.alice.authSessions = {
        broken: null,
        ['a'.repeat(64)]: { createdAt: now - SESSION_LIFETIME_MS - 1, expiresAt: now - 1 },
        [hash]: { createdAt: now, expiresAt: now + SESSION_LIFETIME_MS },
    };
    f.users.set('bob', { username: 'Bob', authSessions: { untouched: 'data' } });
    await f.message('startScratchAuth');
    assert.equal((await f.message('finishScratchAuth', await f.verifyProvider())).ok, true);
    assert.equal(Object.keys(f.alice.authSessions).length, 1);
    assert.equal(authenticate('Alice', otherToken), false);
    assert.equal(authenticate('Alice', 'old-token'), false);
    assert.deepEqual(f.alice.myProjects, ['1']);
    assert.deepEqual(f.users.get('bob').authSessions, { untouched: 'data' });
});

test('a provider identity that differs from the Scratch account is rejected and its unused token revoked', async () => {
    const f = flow();
    await f.message('startScratchAuth');
    const result = await f.message('finishScratchAuth', await f.verifyProvider('Bob'));
    assert.equal(result.ok, false);
    assert.match(result.error, /does not match/);
    assert.equal(f.local.coblocksAuthUsername, 'Alice');
    assert.equal(Object.keys(f.users.get('bob').authSessions).length, 0);
});


test('signing out of Scratch blocks token issuance even with a valid provider callback', async () => {
    const f = flow();
    await f.message('startScratchAuth');
    const sender = await f.verifyProvider();
    f.context.getScratchSession = async () => null;
    f.context.hasScratchSessionCookie = async () => false;
    const result = await f.message('finishScratchAuth', sender);
    assert.equal(result.ok, false);
    assert.match(result.error, /Sign in to Scratch/);
    assert.equal(f.requests.includes('/auth/scratch/finish'), false);
});


test('a lost token response is retried without creating another session', async () => {
    const f = flow({ dropFinishResponse: true });
    await f.message('startScratchAuth');
    assert.equal((await f.message('finishScratchAuth', await f.verifyProvider())).ok, true);
    assert.equal(f.requests.filter(path => path === '/auth/scratch/finish').length, 2);
    assert.equal(Object.keys(f.alice.authSessions).length, 1);
    assert.equal(authenticate('Alice', f.local['lsToken.alice']), true);
});

test('late session verification for an old token cannot invalidate the new login', async () => {
    const f = flow();
    await f.message('startScratchAuth');
    const fetch = f.context.fetch;
    let release;
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    let held = false;
    f.context.fetch = (url, init) => {
        if (url.endsWith('/auth/session') && !held) {
            held = true;
            reached();
            return new Promise(resolve => { release = resolve; });
        }
        return fetch(url, init);
    };
    const oldVerification = f.run('getCurrentCoBlocksTokenAfterUsernameRefresh()');
    await started;
    assert.equal((await f.message('finishScratchAuth', await f.verifyProvider())).ok, true);
    const token = f.local['lsToken.alice'];
    release(new global.Response(JSON.stringify({ noauth: true }), { status: 401, headers: { 'content-type': 'application/json' } }));
    await oldVerification;
    assert.equal(f.local['lsToken.alice'], token);
    assert.equal(authenticate('Alice', token), true);
});
