import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const legacy = readFileSync(new URL('./fixtures/legacy-collaboration-listener.txt', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../../extension/scripts/editor.js', import.meta.url), 'utf8');
const start = editor.indexOf('    collaborationListener = async (msg) => {');
const endMarker = '        } catch (e) { console.error(e); }\n    };';
const current = editor.slice(start, editor.indexOf(endMarker, start) + endMarker.length);

for (const [version, source] of [['previous v1.0.0', legacy], ['updated', current]]) {
    test(`${version} continues blocks, sprite operations, and chat after an unavailable media edit`, async () => {
        const received = [];
        const errors = [];
        const context = vm.createContext({
            coblocksDisabled: false,
            BL_UTILS: { isDragging: () => false },
            lsVersion: 0,
            updateBitmap: async () => { throw new Error('Asset unavailable on this client'); },
            updateSvg: async () => { throw new Error('Asset unavailable on this client'); },
            proxyActions: { renamesprite: (...args) => received.push(['sprite', args[1].args]) },
            onBlockRecieve: message => received.push(['blocks', message.event]),
            addMessage: message => received.push(['chat', message.text]),
            console: { error: error => errors.push(error) },
        });
        vm.runInContext(source, context);
        // Round-trip the additive byte field through the same JSON boundary as
        // extension messaging. Older clients can ignore this field.
        const messages = JSON.parse(JSON.stringify([
            { meta: 'vm.updateBitmap', costumeIndex: 0, costume: { assetId: 'new' }, assetData: [1, 2] },
            { meta: 'vm.updateSvg', costumeIndex: 0, costume: { assetId: 'new' }, assetData: [3, 4] },
            { meta: 'vm.blockListen', event: { type: 'create', blockId: 'block1' } },
            { meta: 'sprite.proxy', data: { name: 'renamesprite', args: ['sprite1', 'Renamed'], extrargs: {} } },
            { meta: 'chat', msg: { sender: 'Alice', text: 'Still connected' } },
        ]));
        for (const message of messages) await context.collaborationListener(message);
        assert.equal(errors.length, 2);
        assert.deepEqual(received.map(event => event[0]), ['blocks', 'sprite', 'chat']);
        assert.equal(context.lsVersion, 4);
        assert.equal(context.coblocksDisabled, false);
    });
}
