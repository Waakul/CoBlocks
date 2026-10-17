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
    for (const invalid of [{ x: Infinity }, { x: '120' }, { space: 'unknown' }, { space: 'editor', x: 0.5, y: 0.5 }, { editorTab: 1 }, { editorTab: 4 }, { targetName: {} }, { space: 'editor', x: 2 }]) {
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
    const canvasMatrix = { a: 2, b: 0, c: 0, d: 2, e: 180, f: 150 };
    const svg = {
        getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 100, f: 50 }),
        createSVGPoint: () => ({ x: 0, y: 0, matrixTransform(matrix) {
            return { x: matrix.a * this.x + matrix.c * this.y + matrix.e, y: matrix.b * this.x + matrix.d * this.y + matrix.f };
        } }),
    };
    const workspace = {
        getParentSvg: () => svg,
        getCanvas: () => ({ getScreenCTM: () => canvasMatrix }),
        getMetrics: () => ({ absoluteLeft: 80, absoluteTop: 0, viewWidth: 720, viewHeight: 650 }),
    };
    const context = vm.createContext({
        entry, lsId: '1', coblocksDisabled: false,
        window: { innerWidth: 1000, innerHeight: 800 }, document: { hidden: false, getElementById: () => null },
        store: { getState: () => ({ scratchGui: { editorTab: { activeTabIndex: 0 } } }) },
        vm: { editingTarget: {} },
        BL_UTILS: { targetToName: () => 'Sprite1', getWorkspace: () => workspace },
    });
    vm.runInContext(source.slice(source.indexOf('function transformPointerPoint('), source.indexOf('function receiveCollaboratorPointer(')), context);
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.style.transform, 'translate(420px, 70px)');
    assert.equal(entry.element.hidden, false);
    entry.pointer = { ...position, targetName: 'Sprite2' };
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.hidden, true);
    entry.pointer = { ...position, space: 'editor' };
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.hidden, true);
    entry.pointer = { ...position, x: -1000 };
    vm.runInContext('positionCollaboratorPointer(entry)', context);
    assert.equal(entry.element.hidden, true);
});


test('pointer sender hides movement outside the blocks canvas and over flyout controls', () => {
    const source = readFileSync(new URL('../../extension/scripts/editor.js', import.meta.url), 'utf8');
    const listeners = {};
    let scheduled;
    let onCanvas = true;
    let overFlyout = false;
    const messages = [];
    const context = vm.createContext({
        collaboratorPointersStarted: false,
        lsId: '1', coblocksDisabled: false, readyToRecieveChanges: true, isConnected: true,
        document: {
            hidden: false, hasFocus: () => true,
            elementFromPoint: () => ({ closest: () => overFlyout }),
            addEventListener: (name, listener) => { listeners[name] = listener; },
            documentElement: { addEventListener() {} },
        },
        window: { addEventListener() {} },
        setTimeout: callback => { scheduled = callback; return 1; }, setInterval() {},
        getBlocksPointerContext: () => onCanvas ? {
            svg: { contains: () => true }, matrix: { inverse() { return this; } },
            rect: { left: 0, top: 0, right: 500, bottom: 500 },
        } : null,
        transformPointerPoint: (_svg, _matrix, x, y) => ({ x, y }),
        BL_UTILS: { targetToName: () => 'Sprite1' }, vm: { editingTarget: {} },
        liveMessage: message => messages.push(message),
    });
    vm.runInContext(source.slice(source.indexOf('function startCollaboratorPointers('), source.indexOf('const collaboratorColors =')), context);
    vm.runInContext('startCollaboratorPointers()', context);
    const move = (x, y) => {
        listeners.pointermove({ isPrimary: true, clientX: x, clientY: y });
        scheduled();
        return messages.at(-1).pointer;
    };
    assert.equal(move(100, 100).visible, true);
    assert.equal(move(600, 100).visible, false);
    overFlyout = true;
    assert.equal(move(100, 100).visible, false);
    overFlyout = false;
    onCanvas = false;
    assert.equal(move(100, 100).visible, false);
});
