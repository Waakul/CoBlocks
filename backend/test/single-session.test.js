import test from 'node:test';
import assert from 'node:assert/strict';
import SessionManager from '../utils/sessionManager.js';

test('replacing a session removes old sockets from all projects and preserves other users and the new session', () => {
    const manager = new SessionManager();
    const sent = [];
    const disconnected = [];
    const socket = (id, token) => ({ id, data: { coblocksToken: token }, send: message => sent.push({ id, message }) });
    const old = socket('old-device', 'old-token');
    const current = socket('current-device', 'new-token');
    const other = socket('other-user', 'other-token');
    manager.projects = {
        one: { session: { connectedClients: {
            old: { username: 'Alice', socket: old },
            current: { username: 'Alice', socket: current },
            other: { username: 'Bob', socket: other },
        } } },
        two: { session: { connectedClients: { old: { username: 'ALICE', socket: old } } } },
    };
    manager.disconnectSocket = client => disconnected.push(client.id);
    manager.replaceUserSession('Alice', 'new-token');
    assert.deepEqual(disconnected, ['old-device']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.noauth, true);
    assert.equal(sent[0].message.token, 'old-token');
    assert.match(sent[0].message.reason, /somewhere else/);
});
