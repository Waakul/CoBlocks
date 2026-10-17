import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const background = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');

test('invite capture preserves the original URL before Scratch redirects', () => {
    const listeners = {};
    const context = vm.createContext({
        URL,
        console,
        chrome: {
            tabs: {
                onCreated: { addListener: listener => { listeners.created = listener; } },
                onUpdated: { addListener: listener => { listeners.updated = listener; } },
            },
            webNavigation: {
                onBeforeNavigate: { addListener: listener => { listeners.beforeNavigate = listener; } },
            },
        },
    });
    vm.runInContext(background.slice(background.indexOf('function getCollaborationInvite('), background.indexOf('let apiUrl;')), context);
    const inviteUrl = 'https://scratch.mit.edu/create?coblocksProject=1&coblocksInvite=test-token';
    listeners.created({ id: 5, pendingUrl: inviteUrl, url: 'about:blank' });
    listeners.updated(5, { url: 'https://scratch.mit.edu/projects/123/editor' }, { id: 5 });
    assert.equal(vm.runInContext('queuedInviteNavigations.get(5).projectId', context), '1');
    listeners.beforeNavigate({ tabId: 6, frameId: 0, url: inviteUrl });
    assert.equal(vm.runInContext('queuedInviteNavigations.get(6).token', context), 'test-token');
    listeners.beforeNavigate({ tabId: 7, frameId: 1, url: inviteUrl });
    assert.equal(vm.runInContext('queuedInviteNavigations.has(7)', context), false);
});

function inviteContext(currentUrl) {
    const requests = [];
    const context = vm.createContext({
        URL,
        projectsPageTester: /^https:\/\/scratch\.mit\.edu\/projects\/\d+/,
        uname: 'Recipient',
        apiUrl: 'https://example.test/apiv2',
        currentCoBlocksToken: 'session-token',
        refreshUsername: async () => 'Recipient',
        chrome: { tabs: { get: async () => ({ id: 5, url: currentUrl }) } },
        authenticatedFetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ projectId: '1', scratchId: null }) };
        },
    });
    const start = background.indexOf('    const newProjects = {}');
    const end = background.indexOf('    const newProjectPage =');
    vm.runInContext(background.slice(start, end), context);
    return { context, requests };
}

test('invite accepted after editor startup notifies the waiting editor', async () => {
    const { context, requests } = inviteContext('https://scratch.mit.edu/projects/123/editor?tutorial=getStarted');
    let initialization;
    context.onInitialized = message => { initialization = message; };
    vm.runInContext('tabCallbacks[5] = onInitialized;', context);
    const result = await vm.runInContext("acceptInvite('1', 'invite-token', 5)", context);
    assert.equal(result.ok, true);
    assert.equal(result.scratchId, '123');
    assert.equal(initialization.lsId, '1');
    assert.equal(requests[1].url, 'https://example.test/apiv2/linkScratch/123/1/Recipient');
});

test('invite accepted before Scratch creates its project links and queues initialization', async () => {
    const { context, requests } = inviteContext('https://scratch.mit.edu/create');
    await vm.runInContext("acceptInvite('1', 'invite-token', 5)", context);
    await vm.runInContext("handleNewProject({ id: 5, url: 'https://scratch.mit.edu/projects/456/editor' })", context);
    assert.equal(requests[1].url, 'https://example.test/apiv2/linkScratch/456/1/Recipient');
    assert.equal(vm.runInContext('pendingTabInitializations[5]', context), '1');
    assert.equal(vm.runInContext('5 in newProjects', context), false);
});
