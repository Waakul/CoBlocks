import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { TextEncoder, TextDecoder } from 'node:util';
import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../../extension/scripts/editor.js', import.meta.url), 'utf8');
const costumes = editor.slice(editor.indexOf('    function sendCostumeUpdate'), editor.indexOf('    newTargetEvents ='));
const sounds = editor.slice(editor.indexOf('    const oldUpdateSoundBuffer'), editor.indexOf('    vm.addSound ='));

function setup() {
    const sent = [];
    const skins = [];
    const destroyed = [];
    const makeTarget = name => {
        const costume = { name: 'costume', skinId: 77, asset: { data: new Uint8Array([1]) } };
        const target = { name, getCostumes: () => [costume], updateAllDrawableProperties() {} };
        target.sprite = { sounds: [{ soundId: 'local-sound' }], clones: [target] };
        return target;
    };
    const first = makeTarget('First');
    const second = makeTarget('Second');
    const asset = bytes => ({ assetId: 'new-asset', data: bytes, assetType: { name: 'ImageVector' }, encodeDataURI: () => 'data:image/png;base64,a' });
    const machine = {
        editingTarget: first,
        runtime: {
            _editingTarget: first,
            storage: {
                AssetType: { ImageVector: { name: 'ImageVector' }, ImageBitmap: { contentType: 'image/png' } },
                createAsset: (_type, _format, bytes) => asset(bytes),
                load: async () => null,
                store() { throw new Error('Sync must not depend on uploading to Scratch'); },
            },
            renderer: {
                createSVGSkin: text => { skins.push(text); return 200; },
                createBitmapSkin: () => { skins.push('bitmap'); return 201; },
                destroySkin: id => destroyed.push(id),
            },
            audioEngine: { audioContext: { decodeAudioData: async data => ({ decoded: Array.from(new Uint8Array(data)) }) } },
        },
        updateSvg(index, text) {
            const costume = this.editingTarget.getCostumes()[index];
            Object.assign(costume, { asset: asset(new TextEncoder().encode(text)), assetId: 'new-asset', dataFormat: 'svg' });
        },
        updateBitmap() {},
        updateSoundBuffer(index, buffer, bytes) { Object.assign(this.editingTarget.sprite.sounds[index], { buffer, bytes }); },
        emitTargetsUpdate() {},
    };
    const context = vm.createContext({
        vm: machine, pauseEventHandling: false, etuListeners: [], proxyActions: {},
        Uint8Array, ArrayBuffer, TextDecoder, Blob, console,
        createImageBitmap: async () => ({ close() {} }),
        BL_UTILS: { nameToTarget: name => [first, second].find(target => target.name === name) },
        nameToTarget: name => [first, second].find(target => target.name === name),
        targetToName: target => target.name,
        liveMessage: message => sent.push(JSON.parse(JSON.stringify(message))),
        getSelectedCostumeIndex: () => -1,
        getPaper: () => null,
    });
    vm.runInContext(costumes + sounds + '\nglobalThis.updateSvg = updateSvg;', context);
    return { context, machine, first, second, sent, skins, destroyed, asset };
}

function costumeMessage(format = 'svg') {
    return { target: 'First', costumeIndex: 0, assetData: [60, 115, 118, 103, 47, 62],
        costume: { skinId: 9999, assetId: 'remote-asset', dataFormat: format,
            bitmapResolution: 2, rotationCenterX: 10, rotationCenterY: 20 } };
}

test('costumes travel as JSON-safe bytes and use receiver-local skins', async () => {
    const { context, first, machine, sent, skins, destroyed } = setup();
    machine.updateSvg(0, '<svg/>');
    assert.deepEqual(sent[0].assetData, [60, 115, 118, 103, 47, 62]);
    assert.equal(sent[0].costume.skinId, undefined);
    await context.updateSvg(costumeMessage());
    assert.equal(first.getCostumes()[0].skinId, 200);
    assert.deepEqual(skins, ['<svg/>']);
    assert.deepEqual(destroyed, [77]);
    await context.updateBitmap(costumeMessage('png'));
    assert.equal(first.getCostumes()[0].skinId, 201);
});

test('missing assets leave the existing costume and renderer intact', async () => {
    const { context, first, destroyed } = setup();
    const before = first.getCostumes()[0].asset;
    const message = costumeMessage();
    delete message.assetData;
    await assert.rejects(context.updateSvg(message), /could not be loaded/);
    assert.equal(first.getCostumes()[0].asset, before);
    assert.equal(first.getCostumes()[0].skinId, 77);
    assert.deepEqual(destroyed, []);
});

test('bitmap completion remains attached to the original sprite after selection changes', () => {
    const { context, machine, first, second, sent, asset } = setup();
    machine.updateBitmap(0, {});
    machine.editingTarget = second;
    const listener = context.etuListeners[0];
    assert.equal(listener(), false);
    assert.equal(sent.length, 0);
    Object.assign(first.getCostumes()[0], { asset: asset(new Uint8Array([4, 5])), dataFormat: 'png' });
    listener();
    assert.equal(sent[0].target, 'First');
    assert.deepEqual(sent[0].assetData, [4, 5]);
});

test('sound edits survive JSON messaging, decode, and preserve the selected sprite', async () => {
    const { context, machine, first, second, sent } = setup();
    const buffer = { sampleRate: 44100 };
    machine.updateSoundBuffer(0, buffer, new Uint8Array([1, 2, 3]));
    assert.deepEqual(sent[0].data.args[2], [1, 2, 3]);
    machine.editingTarget = second;
    machine.runtime._editingTarget = second;
    await context.proxyActions.updatesound('linguini', sent[0].data);
    assert.deepEqual(first.sprite.sounds[0].buffer.decoded, [1, 2, 3]);
    assert.equal(machine.editingTarget, second);
    assert.equal(machine.runtime._editingTarget, second);
    assert.equal(second.sprite.sounds[0].buffer, undefined);
    assert.equal(sent.length, 1);
});

test('the selected vector editor receives SVG text rather than a data URL', async () => {
    const { context } = setup();
    let image;
    context.getSelectedCostumeIndex = () => 0;
    context.getPaper = () => ({ props: { zoomLevelId: 'zoom' }, switchCostume(_format, data) { image = data; } });
    await context.updateSvg(costumeMessage());
    assert.equal(image, '<svg/>');
});

test('new clients still receive legacy costumes that reference uploaded assets', async () => {
    const { context, machine, asset, first } = setup();
    const message = costumeMessage();
    delete message.assetData;
    machine.runtime.storage.load = async () => asset(new Uint8Array([60, 115, 118, 103, 47, 62]));
    await context.updateSvg(message);
    assert.equal(first.getCostumes()[0].skinId, 200);
});

test('new clients accept the previous numeric-object sound encoding', async () => {
    const { context, first } = setup();
    await context.proxyActions.updatesound('linguini', {
        args: [0, {}, { 0: 7, 1: 8, 2: 9 }], extrargs: { target: 'First' },
    });
    assert.deepEqual(first.sprite.sounds[0].buffer.decoded, [7, 8, 9]);
});
