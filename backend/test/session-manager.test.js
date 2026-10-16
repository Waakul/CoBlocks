import assert from 'node:assert/strict';
import test from 'node:test';

import SessionManager from '../utils/sessionManager.js';

test('session manager preserves the legacy storage field while using clear internal names', () => {
    const manager = SessionManager.fromJSON({ lastId: 12, livescratch: {} });

    assert.deepEqual(manager.projects, {});
    assert.deepEqual(manager.toJSON(), { lastId: 12, livescratch: {} });
});

test('project history trimming clears changes already included in the saved snapshot', () => {
    const manager = SessionManager.fromJSON({
        lastId: 1,
        livescratch: {
            1: {
                id: '1',
                scratchId: '10',
                owner: 'owner',
                sharedWith: [],
                linkedWith: [],
                backpack: [],
                chat: [],
                jsonVersion: 1,
                projectJson: { targets: [{ isStage: true }] },
                project: {
                    title: 'Test',
                    version: 1,
                    changes: [{ meta: 'version++' }, { meta: 'version++' }],
                },
            },
        },
    });

    manager.projects['1'].trimChanges();

    assert.deepEqual(manager.projects['1'].project.changes, []);
});
