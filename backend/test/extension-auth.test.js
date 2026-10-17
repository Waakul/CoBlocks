import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../extension/background/auth.js', import.meta.url), 'utf8');
const apiUrl = 'https://example.test/apiv2';
const completionUrl = `${apiUrl}/auth/scratch/complete?state=login-state`;

function authContext(backgroundReady = Promise.resolve()) {
    let pending = { state: 'login-state', tabId: 10, apiUrl };
    const saved = {};
    const navigations = [];
    let finishRequests = 0;
    const context = vm.createContext({
        URL, console, apiUrl, backgroundReady,
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
            return { ok: true, json: async () => ({ username: 'Recipient', token: 'new-token' }) };
        },
        finishVerification: success => { assert.equal(success, true); pending = null; },
        chrome: {
            storage: {
                session: { get: async () => ({ scratchAuthLogin: pending }) },
                local: { set: async values => Object.assign(saved, values) },
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
    vm.runInContext(source.slice(source.indexOf('async function completeScratchAuth('), source.indexOf('chrome.tabs.onRemoved.addListener')), context);
    return { context, saved, navigations, requests: () => finishRequests };
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
