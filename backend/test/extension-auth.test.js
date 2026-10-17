import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../extension/background/auth.js', import.meta.url), 'utf8');
const apiUrl = 'https://example.test/apiv2';
const completionUrl = `${apiUrl}/auth/scratch/complete?state=login-state`;

function authContext(backgroundReady = Promise.resolve(), options = {}) {
    let pending = options.missingState ? null : { state: 'login-state', tabId: 10, apiUrl, createdAt: options.createdAt || Date.now() };
    let sessionReads = 0;
    const saved = {};
    const navigations = [];
    let finishRequests = 0;
    const context = vm.createContext({
        URL, console, apiUrl, backgroundReady, AbortSignal,
        AUTH_USERNAME_KEY: 'coblocksAuthUsername',
        currentCoBlocksToken: null,
        loginState: null, loginTabId: null, loginInFlight: false, verifying: false,
        authCompletionPromise: null,
        COBLOCKS: {
            refreshUsername: async () => {},
            acceptAuthenticatedUsername: async name => name === 'Recipient',
            onAuthenticated: async () => {},
        },
        fetch: async () => {
            finishRequests++;
            return { ok: true, json: async () => ({ username: 'Recipient', token: 'new-token', expiresAt: 123456789 }) };
        },
        finishVerification: success => { assert.equal(success, true); pending = null; },
        chrome: {
            storage: {
                session: { get: async () => { sessionReads++; return { scratchAuthLogin: options.sessionOnly ? pending : null }; } },
                local: { get: async () => ({ scratchAuthLogin: options.sessionOnly ? null : pending }), set: async values => Object.assign(saved, values) },
            },
            runtime: { getURL: path => `chrome-extension://test/${path}` },
            tabs: {
                get: async () => ({ id: 10, url: completionUrl }),
                update: async (id, options) => navigations.push({ id, ...options }),
                onUpdated: { addListener() {} },
            },
            webNavigation: { onCommitted: { addListener() {} } },
        },
    });
    vm.runInContext(source.slice(source.indexOf('async function getPendingScratchAuth('), source.indexOf('chrome.tabs.onRemoved.addListener')), context);
    return { context, saved, navigations, requests: () => finishRequests, sessionReads: () => sessionReads };
}

test('auth callback waits for worker initialization and duplicate events consume the token once', async () => {
    let ready;
    const backgroundReady = new Promise(resolve => { ready = resolve; });
    const { context, saved, navigations, requests } = authContext(backgroundReady);
    context.completionUrl = completionUrl;
    const first = vm.runInContext('handleScratchAuthCompletion(10, completionUrl)', context);
    const duplicate = vm.runInContext('handleScratchAuthCompletion(10, completionUrl)', context);
    await Promise.resolve();
    assert.equal(requests(), 0);
    ready();
    await Promise.all([first, duplicate]);
    assert.equal(requests(), 1);
    assert.equal(saved['lsToken.recipient'], 'new-token');
    assert.equal(saved.coblocksAuthUsername, 'Recipient');
    assert.equal(saved['lsTokenExpiresAt.recipient'], 123456789);
    assert.equal(navigations.length, 1);
    assert.equal(navigations[0].url, 'chrome-extension://test/auth/success.html?username=Recipient');
});

test('worker startup recovers an auth tab already on the completion page', async () => {
    const { context, saved, requests } = authContext();
    await vm.runInContext('resumeScratchAuth()', context);
    assert.equal(requests(), 1);
    assert.equal(saved['lsToken.recipient'], 'new-token');
});

test('auth completion rejects an unrelated origin without claiming the token', async () => {
    const { context, requests } = authContext();
    await vm.runInContext("handleScratchAuthCompletion(10, 'https://untrusted.test/apiv2/auth/scratch/complete?state=login-state')", context);
    assert.equal(requests(), 0);
});


test('auth completion survives cleared session storage and a replacement tab', async () => {
    const { context, saved, navigations } = authContext();
    context.completionUrl = completionUrl;
    const result = await vm.runInContext('handleScratchAuthCompletion(25, completionUrl)', context);
    assert.equal(result.ok, true);
    assert.equal(saved['lsToken.recipient'], 'new-token');
    assert.equal(navigations[0].id, 25);
});

test('old session-only login state remains compatible', async () => {
    const { context, saved } = authContext(Promise.resolve(), { sessionOnly: true });
    await vm.runInContext('resumeScratchAuth()', context);
    assert.equal(saved['lsToken.recipient'], 'new-token');
});

test('missing and expired pending logins return an error instead of hanging', async () => {
    for (const options of [{ missingState: true }, { createdAt: Date.now() - 6 * 60_000 }]) {
        const { context, requests } = authContext(Promise.resolve(), options);
        context.completionUrl = completionUrl;
        const result = await vm.runInContext('handleScratchAuthCompletion(10, completionUrl)', context);
        assert.equal(result.ok, false);
        assert.match(result.error, /expired/);
        assert.equal(requests(), 0);
    }
});

test('a replacement tab must still present the exact pending login state', async () => {
    const { context, requests } = authContext();
    context.completionUrl = completionUrl.replace('login-state', 'wrong-state');
    const result = await vm.runInContext('handleScratchAuthCompletion(25, completionUrl)', context);
    assert.equal(result.ok, false);
    assert.equal(requests(), 0);
});

test('completion page explicitly wakes the worker and displays completion errors', () => {
    const page = readFileSync(new URL('../../extension/auth/complete.js', import.meta.url), 'utf8');
    const heading = {};
    const status = {};
    let request;
    const context = vm.createContext({
        document: { querySelector: selector => selector === 'h1' ? heading : status },
        setTimeout: () => 1,
        clearTimeout() {},
        chrome: { runtime: { sendMessage: (message, callback) => {
            request = message;
            callback({ ok: false, error: 'Login expired. Sign in again.' });
        } } },
    });
    vm.runInContext(page, context);
    assert.equal(request.meta, 'finishScratchAuth');
    assert.equal(heading.textContent, 'CoBlocks sign-in needs attention');
    assert.equal(status.textContent, 'Login expired. Sign in again.');
});
