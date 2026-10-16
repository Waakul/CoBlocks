import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

export function createInvite(now = Date.now()) {
    const token = randomBytes(32).toString('base64url');
    return {
        token,
        storedInvite: {
            tokenHash: hashToken(token),
            createdAt: now,
            expiresAt: now + INVITE_LIFETIME_MS,
        },
    };
}

export function isInviteValid(invite, token, now = Date.now()) {
    if (!invite || typeof token !== 'string' || token.length < 32 || token.length > 128 || invite.expiresAt <= now) return false;
    if (!/^[a-f0-9]{64}$/.test(invite.tokenHash || '')) return false;

    const actual = Buffer.from(hashToken(token), 'hex');
    const expected = Buffer.from(invite.tokenHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
