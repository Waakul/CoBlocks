import test from 'node:test';
import assert from 'node:assert/strict';
import SessionManager from '../utils/sessionManager.js';

test('presence events use the first join and final leave for each user', () => {
    const manager = new SessionManager();
    const messages = [];
    const clients = {
        alice: { username: 'Alice' },
    };
    const project = {
        id: '1',
        scratchId: '100',
        session: {
            connectedClients: clients,
            getConnectedUsernames: () => [...new Set(Object.values(clients).map(client => client.username.toLowerCase()))],
            sendChangeFrom: (socket, message) => messages.push({ excludedSocket: socket?.id, message }),
            removeClient: id => {
                const username = clients[id]?.username;
                delete clients[id];
                return username;
            },
        },
        joinSession: (socket, username) => { clients[socket.id] = { username }; },
    };
    manager.getProject = () => project;

    manager.join({ id: 'bob-1' }, project.id, 'Bob');
    manager.join({ id: 'bob-2' }, project.id, 'Bob');
    manager.leave({ id: 'bob-1' }, project.id);
    manager.leave({ id: 'bob-2' }, project.id);

    assert.deepEqual(messages, [
        { excludedSocket: 'bob-1', message: { meta: 'presence', action: 'join', username: 'Bob' } },
        { excludedSocket: undefined, message: { meta: 'presence', action: 'leave', username: 'Bob' } },
    ]);
});
