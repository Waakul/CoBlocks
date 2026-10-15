import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    deleteRedundantJson,
    readRedundantJson,
    recoverFileFromRedundancy,
    seedAndRecoverDirectory,
    writeRedundantJson,
} from '../utils/redundantStorage.js';

function temporaryStorage() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'livescratch-recovery-'));
    return {
        directory,
        primary: path.join(directory, 'primary'),
        redundancy: path.join(directory, 'redundancy'),
    };
}

test('redundant storage recovers a missing or corrupted primary file', t => {
    const storage = temporaryStorage();
    t.after(() => fs.rmSync(storage.directory, { recursive: true, force: true }));
    fs.mkdirSync(storage.primary, { recursive: true });

    const original = JSON.stringify({ id: '42', project: { title: 'Safe copy' } });
    fs.writeFileSync(path.join(storage.primary, '42'), original);
    seedAndRecoverDirectory(storage.primary, 'projects', { root: storage.redundancy });

    fs.rmSync(storage.primary, { recursive: true, force: true });
    const restoredDirectory = seedAndRecoverDirectory(storage.primary, 'projects', { root: storage.redundancy });
    assert.equal(restoredDirectory.recovered, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage.primary, '42'), 'utf8')), JSON.parse(original));

    fs.writeFileSync(path.join(storage.primary, '42'), '{damaged');
    const recovered = recoverFileFromRedundancy(path.join(storage.primary, '42'), 'projects', '42', { root: storage.redundancy });

    assert.equal(recovered, original);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(storage.primary, '42'), 'utf8')), JSON.parse(original));
});

test('recovery falls back through rotating generations when the mirror is damaged', t => {
    const storage = temporaryStorage();
    t.after(() => fs.rmSync(storage.directory, { recursive: true, force: true }));

    assert.equal(writeRedundantJson('projects', '7', JSON.stringify({ version: 1 }), { root: storage.redundancy }), true);
    assert.equal(writeRedundantJson('projects', '7', JSON.stringify({ version: 2 }), { root: storage.redundancy }), true);
    fs.writeFileSync(path.join(storage.redundancy, 'mirrors', 'projects', '7'), 'corrupted');

    assert.deepEqual(JSON.parse(readRedundantJson('projects', '7', { root: storage.redundancy })), { version: 2 });
});

test('explicit deletion removes mirrors and generations so deleted projects stay deleted', t => {
    const storage = temporaryStorage();
    t.after(() => fs.rmSync(storage.directory, { recursive: true, force: true }));

    writeRedundantJson('projects', '9', JSON.stringify({ id: '9' }), { root: storage.redundancy });
    assert.ok(readRedundantJson('projects', '9', { root: storage.redundancy }));
    deleteRedundantJson('projects', '9', { root: storage.redundancy });
    assert.equal(readRedundantJson('projects', '9', { root: storage.redundancy }), null);
});
