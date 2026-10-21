import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../../extension/popups/script.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(script.slice(0, script.indexOf("chrome.storage.local.get('theme'")), context);
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('friends API errors show the backend reason rather than calling forEach on an object', async () => {
    await assert.rejects(context.readFriendsResponse(response(429, { err: 'Too many requests. Try again shortly.' })), /Too many requests/);
    await assert.rejects(context.readFriendsResponse(response(503, { err: 'Server unavailable' })), /Server unavailable/);
    await assert.rejects(context.readFriendsResponse(response(200, {})), /invalid friends list/);
});

test('friends authentication errors and valid empty lists remain distinct', async () => {
    assert.equal(await context.readFriendsResponse(response(401, { noauth: true })), null);
    assert.deepEqual(Array.from(await context.readFriendsResponse(response(200, []))), []);
    assert.deepEqual(Array.from(await context.readFriendsResponse(response(200, ['Alice', null]))), ['Alice']);
});
