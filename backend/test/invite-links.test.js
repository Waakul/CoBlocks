import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvite, INVITE_LIFETIME_MS, isInviteValid } from '../utils/inviteLinks.js';

test('invite tokens validate without storing the raw token', () => {
    const now = 1_000;
    const { token, storedInvite } = createInvite(now);

    assert.equal(storedInvite.token, undefined);
    assert.equal(isInviteValid(storedInvite, token, now), true);
    assert.equal(isInviteValid(storedInvite, `${token}wrong`, now), false);
});

test('invite tokens expire after seven days', () => {
    const now = 1_000;
    const { token, storedInvite } = createInvite(now);

    assert.equal(isInviteValid(storedInvite, token, now + INVITE_LIFETIME_MS - 1), true);
    assert.equal(isInviteValid(storedInvite, token, now + INVITE_LIFETIME_MS), false);
});

test('malformed invite data is rejected', () => {
    assert.equal(isInviteValid(null, 'long-enough-token-value-that-is-invalid'), false);
    assert.equal(isInviteValid({ tokenHash: 'bad', expiresAt: Date.now() + 10_000 }, 'long-enough-token-value-that-is-invalid'), false);
});
