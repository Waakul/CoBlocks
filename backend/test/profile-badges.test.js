import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';

const badgeScript = readFileSync(new URL('../../extension/scripts/badge.js', import.meta.url), 'utf8');

class Username {
    isConnected = true;
    children = [];
    constructor(name) { this.textContent = name; }
    getAttribute() { return `/users/${this.textContent}/`; }
    append(child) { this.children.push(child); }
}

async function settle() {
    for (let i = 0; i < 6; i++) await setImmediate();
}

function setup(names, lookup) {
    const users = names.map(name => new Username(name));
    vm.runInNewContext(badgeScript, {
        Element: Username,
        getComputedStyle: () => ({ fontSize: '14px' }),
        document: {
            documentElement: {},
            querySelector: () => ({ dataset: { exId: 'test', logoUrl: 'logo.png' } }),
            querySelectorAll: () => users,
            createElement: () => ({ style: { setProperty() {} } }),
        },
        MutationObserver: class { observe() {} },
        window: { coBlocksRuntime: { sendMessage(_id, message, callback) {
            if (message.meta === 'badges?') callback({ badges: false });
            else lookup(message.username, callback);
        } } },
        console,
    });
    return users;
}

test('only confirmed CoBlocks accounts receive a small inline badge', async () => {
    const responses = { Alice: true, Bobby: false, Carol: { err: 'Too many requests' }, Danny: { ok: false } };
    const users = setup(Object.keys(responses), (name, callback) => callback(responses[name]));
    await settle();
    assert.equal(users[0].children.length, 1);
    assert.equal(users[0].children[0].width, 17);
    assert.equal(users[0].children[0].height, 17);
    for (const user of users.slice(1)) assert.equal(user.children.length, 0);
});

test('a followers page limits simultaneous user lookups', async () => {
    const callbacks = [];
    setup(['Alice', 'Bobby', 'Carol', 'Danny', 'Ernie', 'Frank'], (_name, callback) => callbacks.push(callback));
    await settle();
    assert.equal(callbacks.length, 4);
    callbacks[0](false);
    await settle();
    assert.equal(callbacks.length, 5);
});

test('lookup failures are not cached as successful account checks', async () => {
    const source = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
    const start = source.indexOf('    let userExistsStore =');
    const end = source.indexOf('\n    }', source.indexOf('    async function testUserExists', start)) + 6;
    let calls = 0;
    const context = vm.createContext({
        apiUrl: 'https://example.test',
        AbortSignal: { timeout: () => undefined },
        fetch: async () => {
            calls++;
            return calls === 1 ? { ok: false, status: 429 } : { ok: true, json: async () => true };
        },
    });
    vm.runInContext(source.slice(start, end), context);
    await assert.rejects(context.testUserExists('Alice'), /429/);
    assert.equal(await context.testUserExists('Alice'), true);
    assert.equal(await context.testUserExists('Alice'), true);
    assert.equal(calls, 2);
});
