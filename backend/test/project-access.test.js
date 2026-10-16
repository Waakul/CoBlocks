import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAllowsUser, reconcileProjectReferences, scratchLinkConflicts, userOwnsProject } from '../utils/projectAccess.js';

test('project membership is authoritative and case insensitive', () => {
    const project = { owner: 'Alice', sharedWith: ['Bob'] };
    assert.equal(projectAllowsUser(project, 'alice'), true);
    assert.equal(projectAllowsUser(project, 'BOB'), true);
    assert.equal(projectAllowsUser(project, 'Mallory'), false);
    assert.equal(userOwnsProject(project, 'ALICE'), true);
    assert.equal(userOwnsProject(project, 'Bob'), false);
});

test('Scratch IDs cannot be remapped to another CoBlocks project', () => {
    assert.equal(scratchLinkConflicts(null, '12'), false);
    assert.equal(scratchLinkConflicts({ lsId: '12' }, 12), false);
    assert.equal(scratchLinkConflicts({ lsId: '99' }, '12'), true);
});

test('My Stuff drops stale and foreign project references', () => {
    const user = {
        username: 'Alice',
        friends: ['bob'],
        myProjects: ['1', '2', '404'],
        sharedTo: {
            3: { id: '3', from: 'Bob' },
            4: { id: '4', from: 'Bob' },
        },
    };
    const projects = {
        1: { owner: 'Alice', sharedWith: [] },
        2: { owner: 'SomeoneElse', sharedWith: [] },
        3: { owner: 'Bob', sharedWith: ['ALICE'] },
        4: { owner: 'Bob', sharedWith: ['OtherUser'] },
    };

    const result = reconcileProjectReferences('alice', user, id => projects[id]);

    assert.deepEqual(result.authorizedIds, ['1', '3']);
    assert.deepEqual(result.removedIds, ['2', '404', '4']);
    assert.deepEqual(user.myProjects, ['1']);
    assert.deepEqual(user.sharedTo, { 3: { id: '3', from: 'Bob' } });
});

test('invite collaborators remain visible without being friends with the owner', () => {
    const user = {
        username: 'Alice',
        friends: [],
        myProjects: [],
        sharedTo: { 3: { id: '3', from: 'Bob', invited: true } },
    };
    const projects = { 3: { owner: 'Bob', sharedWith: ['Alice'] } };

    assert.deepEqual(reconcileProjectReferences('Alice', user, id => projects[id]).authorizedIds, ['3']);
});
