import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireBuildTool = createRequire(new URL('../../scripts/package.json', import.meta.url));
let Decoder;
try { ({ Decoder } = requireBuildTool('socket.io-parser')); } catch { /* Build dependencies are optional for backend-only installs. */ }

for (const index of ['splice', 'push', 'hasOwnProperty', 10, -1]) {
    test(`Socket.IO parser rejects invalid binary placeholder ${index}`, { skip: !Decoder }, () => {
        const decoder = new Decoder();
        let decoded = false;
        decoder.on('decoded', () => { decoded = true; });
        assert.throws(() => {
            decoder.add(`51-["hello",{"_placeholder":true,"num":${JSON.stringify(index)}}]`);
            decoder.add(Buffer.from('world'));
        });
        assert.equal(decoded, false);
        decoder.destroy();
    });
}

test('Socket.IO parser accepts legitimate binary attachments', { skip: !Decoder }, () => {
    const decoder = new Decoder();
    let payload;
    decoder.on('decoded', packet => { payload = packet.data; });
    decoder.add('51-["hello",{"_placeholder":true,"num":0}]');
    decoder.add(Buffer.from('world'));
    assert.equal(payload[1].toString(), 'world');
    decoder.destroy();
});

test('the shipped browser client initializes without string evaluation', () => {
    const self = { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
    const context = vm.createContext({ self, setTimeout, clearTimeout, console, URL,
        Function() { throw new Error('Dynamic evaluation is forbidden'); } });
    const source = readFileSync(new URL('../../extension/background/socket.io.js', import.meta.url), 'utf8');
    vm.runInContext(source, context, { timeout: 2000 });
    const socket = self.io.connect('https://example.invalid', { autoConnect: false, transports: ['websocket'] });
    assert.equal(typeof socket.on, 'function');
    socket.disconnect();
});
