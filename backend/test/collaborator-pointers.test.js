import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import SocketServer from '../WebSockets.js';

function pointerServer(authorized = true) {
    const messages = [];
    const member = { username: 'Bob' };
    const server = Object.create(SocketServer.prototype);
    server.requireProjectAccess = () => authorized;
    server.requireJoinedIdentity = () => authorized;
    server.sessionManager = { getProject: () => ({ session: {
        getClientFromSocket: () => member,
        sendChangeFrom: (client, message, excludeVersion) => messages.push({ client, message, excludeVersion }),
    } }) };
    return { server, messages, member };
}

const position = { visible: true, x: 120, y: -40, space: 'workspace', targetName: 'Sprite1', editorTab: 0 };

test('live pointers use the joined identity and bypass project history', () => {
    const { server, messages } = pointerServer();
    const client = { id: 'bob' };
    server.pointer({ lsId: '1', username: 'Bob', pointer: { ...position, extra: 'discard' } }, client);
    assert.deepEqual(messages, [{ client, message: { meta: 'pointer', username: 'Bob', pointer: position }, excludeVersion: true }]);
});

test('live pointers reject unauthorized and malformed positions', () => {
    const denied = pointerServer(false);
    denied.server.pointer({ lsId: '1', pointer: position }, {});
    assert.equal(denied.messages.length, 0);
    const { server, messages } = pointerServer();
    for (const invalid of [{ x: Infinity }, { x: '120' }, { space: 'unknown' }, { editorTab: 4 }, { targetName: {} }, { space: 'editor', x: 2 }]) {
        server.pointer({ lsId: '1', pointer: { ...position, ...invalid } }, {});
    }
    assert.equal(messages.length, 0);
});

test('pointer movement is throttled but hiding the cursor is immediate', () => {
    const { server, messages } = pointerServer();
    server.pointer({ lsId: '1', pointer: position }, {});
    server.pointer({ lsId: '1', pointer: position }, {});
    server.pointer({ lsId: '1', pointer: { visible: false } }, {});
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1].message.pointer, { visible: false });
});

test('workspace pointers follow local zoom and scroll and hide on other sprites', () => {
    const source = readFileSync(new URL('../../extension/scripts/editor.js', import.meta.url), 'utf8');
    const entry = { pointer: position, element: { style: {} } };
    const workspace = { scale: 2, scrollX: -50, scrollY: 100, getParentSvg: () => ({ getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 700 }) }) };
    const context = vm.createContext({
        entry, lsId: '1', coblocksDisabled: false,
        window: { innerWidth: 1000, innerHeight: 800 }, document: { hidden: false },
        store: { getState: () => ({ scratchGui: { editorTab: { activeTabIndex: 0 } } }) },
        vm: { editingTarget: {} },
        BL_UTILS: { targetToName: () => 'Sprite1', getWorkspace: () => workspace },
    });
    vm.runInContext(source.slice(source.indexOf('function positionCollaboratorPointer('), source.indexOf('function receiveCollaboratorPointer(')), context);
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.style.transform, 'translate(290px, 70px)');
    assert.equal(entry.element.hidden, false);
    entry.pointer = { ...position, targetName: 'Sprite2' };
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.hidden, true);
});
