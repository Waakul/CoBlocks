import test from 'node:test';
import assert from 'node:assert/strict';
import { canDeleteBackpackItem, normalizeBackpack, validateBackpackItem } from '../utils/backpack.js';

test('shared backpack accepts native Scratch VM block objects', () => {
    const blocks = [{ id: 'top', opcode: 'motion_movesteps', inputs: {}, fields: {}, next: null, parent: null, topLevel: true }];
    assert.deepEqual(validateBackpackItem({ name: 'Movement', blocks }).value, {
        type: 'script',
        name: 'Movement',
        blocks,
        thumbnail: null,
    });
    assert.match(validateBackpackItem({ name: 'Bad', blocks: [{ id: 'x' }] }).error, /invalid/i);
    assert.match(validateBackpackItem({ name: 'Bad', blocks: [] }).error, /not valid/i);
});

test('backpack deletion is limited to its creator or project owner', () => {
    const project = { owner: 'Alice' };
    const item = { createdBy: 'Bob' };
    assert.equal(canDeleteBackpackItem(project, item, 'ALICE'), true);
    assert.equal(canDeleteBackpackItem(project, item, 'bob'), true);
    assert.equal(canDeleteBackpackItem(project, item, 'Mallory'), false);
});

test('legacy projects receive an empty backpack', () => {
    const project = { backpack: [{ id: 'legacy', xml: '<block></block>' }] };
    assert.deepEqual(normalizeBackpack(project), []);
    assert.equal(project.backpack, normalizeBackpack(project));
});
