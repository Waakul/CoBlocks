import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const extensionRoot = new URL('../../extension/', import.meta.url);
const runtimeSource = readFileSync(new URL('scripts/runtime.js', extensionRoot), 'utf8');

test('the same manifest provides Chrome and Firefox background entry points', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', extensionRoot), 'utf8'));
    assert.equal(manifest.background.service_worker, 'background.js');
    assert.deepEqual(manifest.background.scripts, ['background/socket.io.js', 'background/auth.js', 'background.js']);
    assert.equal(manifest.minimum_chrome_version, '121');
    assert.equal(manifest.browser_specific_settings.gecko.id, 'coblocks@waakul.com');
    assert.ok(manifest.web_accessible_resources[0].resources.includes('scripts/runtime.js'));
    for (const script of manifest.content_scripts.flatMap(entry => entry.js || [])) {
        assert.ok(existsSync(new URL(script, extensionRoot)), script);
    }
    const scratchScripts = manifest.content_scripts.filter(entry => entry.matches.includes('https://scratch.mit.edu/*'));
    assert.equal(scratchScripts[0].js[0], 'injectors/bridge.js');
});

function pageRuntime(nativeRuntime) {
    const sent = [];
    const listeners = {};
    const window = {
        chrome: nativeRuntime ? { runtime: nativeRuntime } : undefined,
        postMessage: (data, origin) => sent.push({ data: JSON.parse(data), origin }),
        addEventListener: (type, listener) => { listeners[type] = listener; },
    };
    const context = vm.createContext({
        window, location: { origin: 'https://scratch.mit.edu' },
        document: { currentScript: { dataset: { channel: 'test-channel' } } },
    });
    vm.runInContext(runtimeSource, context);
    const reply = (message, origin = 'https://scratch.mit.edu') => listeners.message({
        source: window, origin,
        data: JSON.stringify({ channel: 'test-channel', direction: 'extension', ...message }),
    });
    return { runtime: window.coBlocksRuntime, sent, reply };
}

test('Chrome keeps its native extension messaging implementation', () => {
    let request;
    const port = {};
    const nativeRuntime = { sendMessage: (...args) => { request = args; }, connect: () => port };
    const { runtime } = pageRuntime(nativeRuntime);
    runtime.sendMessage('extension', { meta: 'getUsernamePlus' });
    assert.equal(request[0], 'extension');
    assert.equal(request[1].meta, 'getUsernamePlus');
    assert.equal(runtime.connect('extension'), port);
});

test('Firefox bridge correlates replies and exposes errors only during callbacks', () => {
    const { runtime, sent, reply } = pageRuntime();
    let result;
    let error;
    runtime.sendMessage('extension', { meta: 'getUsernamePlus' }, data => {
        result = data;
        error = runtime.lastError?.message;
    });
    assert.equal(sent[0].origin, 'https://scratch.mit.edu');
    const id = sent[0].data.id;
    reply({ type: 'response', id, response: 'forged' }, 'https://untrusted.test');
    assert.equal(result, undefined);
    reply({ type: 'response', id, response: { uname: 'Alice' }, error: 'test error' });
    assert.equal(result.uname, 'Alice');
    assert.equal(error, 'test error');
    assert.equal(runtime.lastError, null);
});

test('Firefox collaboration ports support messaging, disconnects, and JSON-compatible events', () => {
    const { runtime, sent, reply } = pageRuntime();
    const port = runtime.connect('extension');
    const id = sent[0].data.id;
    let incoming;
    let disconnected = false;
    port.onMessage.addListener(message => { incoming = message; });
    port.onDisconnect.addListener(() => { disconnected = true; });
    port.postMessage({ meta: 'vm.blockListen', event: { type: 'move', callback() {} } });
    assert.equal(sent[1].data.id, id);
    assert.equal(sent[1].data.data.event.type, 'move');
    assert.equal(sent[1].data.data.event.callback, undefined);
    reply({ type: 'port-message', id, data: { meta: 'pointer' } });
    assert.equal(incoming.meta, 'pointer');
    reply({ type: 'port-disconnect', id });
    assert.equal(disconnected, true);
});

test('clipboard requests use the content bridge in both browsers', async () => {
    for (const nativeRuntime of [undefined, { sendMessage() {} }]) {
        const { runtime, sent, reply } = pageRuntime(nativeRuntime);
        const copied = runtime.copyText('https://scratch.mit.edu/create?invite=test');
        assert.equal(sent[0].data.type, 'clipboard');
        assert.equal(sent[0].data.text, 'https://scratch.mit.edu/create?invite=test');
        reply({ type: 'response', id: sent[0].data.id });
        await copied;
    }
});
