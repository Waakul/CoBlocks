import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../extension/background/updates.js', import.meta.url), 'utf8');

function notices(options = {}) {
    const stored = { pendingExtensionUpdate: { version: '0.4.0' } };
    let listener;
    const context = vm.createContext({
        URL, AbortSignal, console,
        fetch: async () => ({ ok: !options.offline, status: 404, json: async () => ({
            name: 'CoBlocks 0.4.0', body: '# Changes\n\n- Live cursors\n- [Invite links](https://example.test)',
            html_url: 'https://github.com/Waakul/CoBlocks/releases/tag/v0.4.0',
        }) }),
        chrome: {
            storage: { local: {
                get: async () => JSON.parse(JSON.stringify(stored)),
                set: async values => Object.assign(stored, values),
                remove: async keys => { for (const key of keys) delete stored[key]; },
            } },
            runtime: { onMessage: { addListener: handler => { listener = handler; } } },
        },
    });
    vm.runInContext(source, context);
    const request = (meta, tabId = 1, extra = {}) => new Promise(resolve => {
        listener({ meta, ...extra }, { tab: { id: tabId }, url: 'https://scratch.mit.edu/projects/1/editor' }, resolve);
    });
    return { stored, request };
}

test('an update notice is claimed by one Scratch tab and acknowledged once rendered', async () => {
    const { stored, request } = notices();
    const [first, second] = await Promise.all([
        request('getExtensionUpdateNotice'), request('getExtensionUpdateNotice', 2),
    ]);
    assert.equal(first.version, '0.4.0');
    assert.equal(second, null);
    assert.equal(first.release.url, 'https://github.com/Waakul/CoBlocks/releases/tag/v0.4.0');
    assert.equal(first.release.preview.includes('Live cursors'), true);
    assert.equal(first.release.preview.includes('https://example.test'), false);
    await request('extensionUpdateNoticeShown', 1, { version: '0.4.0' });
    assert.equal(stored.pendingExtensionUpdate, undefined);
    assert.equal(await request('getExtensionUpdateNotice'), null);
});

test('another tab or an older version cannot acknowledge an unseen notice', async () => {
    const { stored, request } = notices();
    await request('getExtensionUpdateNotice');
    await request('extensionUpdateNoticeShown', 2, { version: '0.4.0' });
    assert.ok(stored.pendingExtensionUpdate);
    await request('extensionUpdateNoticeShown', 1, { version: '0.3.0' });
    assert.ok(stored.pendingExtensionUpdate);
});

test('a tab that navigated away before rendering does not consume the notice', async () => {
    const { stored, request } = notices();
    await request('getExtensionUpdateNotice');
    stored.extensionUpdateClaim.claimedAt -= 31_000;
    assert.equal((await request('getExtensionUpdateNotice', 2)).version, '0.4.0');
});

test('missing GitHub releases still provide a usable notice and releases link', async () => {
    const { request } = notices({ offline: true });
    const notice = await request('getExtensionUpdateNotice');
    assert.equal(notice.release.url, 'https://github.com/Waakul/CoBlocks/releases');
    assert.ok(notice.release.preview);
});


test('version updates queue a notice without opening a website, while same-version reloads do not', async () => {
    const background = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
    let handler;
    const stored = { apiUpdateReload: true };
    const tabs = [];
    const context = vm.createContext({
        chrome: {
            storage: { local: {
                get: async () => ({ ...stored }),
                set: async values => Object.assign(stored, values),
                remove: async key => { delete stored[key]; },
            } },
            runtime: {
                OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
                getManifest: () => ({ version: '0.4.0', version_name: '0.4.0-pre' }),
                onInstalled: { addListener: listener => { handler = listener; } },
            },
            tabs: { create: tab => tabs.push(tab) },
        },
    });
    vm.runInContext(background.slice(background.indexOf('chrome.runtime.onInstalled.addListener'), background.indexOf('const COBLOCKS =')), context);
    await handler({ reason: 'update', previousVersion: '0.3.0' });
    assert.equal(stored.pendingExtensionUpdate.version, '0.4.0-pre');
    assert.equal(tabs.length, 0);
    delete stored.pendingExtensionUpdate;
    await handler({ reason: 'update', previousVersion: '0.4.0' });
    assert.equal(stored.pendingExtensionUpdate, undefined);
});
