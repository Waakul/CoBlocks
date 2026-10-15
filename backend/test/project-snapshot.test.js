import test from 'node:test';
import assert from 'node:assert/strict';
import { isScratchProjectJson, normalizeScratchProjectJson } from '../utils/projectSnapshot.js';

const validProject = { targets: [{ isStage: true, blocks: {} }], monitors: [], extensions: [] };

test('Scratch project snapshots accept object and serialized project data', () => {
    assert.equal(isScratchProjectJson(validProject), true);
    assert.deepEqual(normalizeScratchProjectJson(JSON.stringify(validProject)), validProject);
});

test('Scratch project snapshots reject malformed or incomplete data', () => {
    assert.equal(isScratchProjectJson('{bad json'), false);
    assert.equal(isScratchProjectJson({ targets: 'not an array' }), false);
    assert.equal(isScratchProjectJson({ targets: [{ blocks: {} }] }), false);
});
