/* exported authenticatedFetch, clearRejectedCredentials, currentCoBlocksToken, getCurrentCoBlocksTokenAfterUsernameRefresh, logoutCoBlocks, resumeScratchAuth */

let currentCoBlocksToken = null;
let verifying = false;
let verifyError = null;
let loginTabId = null;
let loginState = null;
let loginInFlight = false;
let credentialResetPromise = null;
let authCompletionPromise = null;
let authCompletionState = null;
let credentialVersion = 0;
const endVerifyCallbacks = [];
const startVerifyCallbacks = [];
const AUTH_USERNAME_KEY = 'coblocksAuthUsername';
const AUTH_COMPLETION_KEY = 'coblocksAuthCompletion';

async function getCoBlocksToken(username) {
    if (!username || username === '*') return null;
    const key = `lsToken.${username.toLowerCase()}`;
    const oldKey = `blToken.${username.toLowerCase()}`;
    const stored = await chrome.storage.local.get([key, oldKey]);
    if (!stored[key] && stored[oldKey]) {
        await chrome.storage.local.set({ [key]: stored[oldKey] });
        await chrome.storage.local.remove(oldKey);
    }
    return stored[key] || stored[oldKey] || null;
}

async function clearCurrentCoBlocksToken({ clearAllTokens = false } = {}) {
    credentialVersion++;
    const rejectedToken = currentCoBlocksToken;
    const stored = await chrome.storage.local.get(null);
    const matchingTokenKeys = Object.entries(stored)
        .filter(([key, value]) => /^(lsToken|blToken|lsTokenExpiresAt)\./.test(key) && (clearAllTokens || value === rejectedToken))
        .map(([key]) => key);
    const usernames = new Set([uname, stored[AUTH_USERNAME_KEY]].filter(username => username && username !== '*'));
    for (const username of usernames) {
        matchingTokenKeys.push(
            `lsToken.${username.toLowerCase()}`,
            `blToken.${username.toLowerCase()}`,
            `lsTokenExpiresAt.${username.toLowerCase()}`,
        );
    }
    await chrome.storage.local.remove([...new Set([...matchingTokenKeys, AUTH_USERNAME_KEY, AUTH_COMPLETION_KEY])]);
    currentCoBlocksToken = null;
}

async function getCurrentCoBlocksTokenAfterUsernameRefresh() {
    const version = credentialVersion;
    const scratchUsername = uname;
    if (!scratchUsername || scratchUsername === '*') {
        currentCoBlocksToken = null;
        return null;
    }

    const stored = await chrome.storage.local.get(AUTH_USERNAME_KEY);
    if (version !== credentialVersion || scratchUsername !== uname) return currentCoBlocksToken;
    const authenticatedUsername = stored[AUTH_USERNAME_KEY];
    if (authenticatedUsername && typeof authenticatedUsername !== 'string') {
        await clearRejectedCredentials('The saved CoBlocks login was invalid. Sign in again.', { clearAllTokens: true });
        return null;
    }
    if (authenticatedUsername
        && authenticatedUsername.toLowerCase() !== scratchUsername.toLowerCase()) {
        currentCoBlocksToken = await getCoBlocksToken(authenticatedUsername);
        await clearRejectedCredentials(
            'Your Scratch account changed. Sign in to CoBlocks again with the current Scratch account.',
            { clearAllTokens: true },
        );
        return null;
    }

    const token = await getCoBlocksToken(scratchUsername);
    if (version !== credentialVersion || scratchUsername !== uname) return currentCoBlocksToken;
    currentCoBlocksToken = token;
    if (!token) {
        if (authenticatedUsername) await chrome.storage.local.remove(AUTH_USERNAME_KEY);
        return null;
    }

    try {
        const response = await fetch(`${apiUrl}/auth/session`, {
            method: 'POST',
            credentials: 'omit',
            signal: AbortSignal.timeout(8000),
            headers: { authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: scratchUsername }),
        });
        const data = await response.json().catch(() => ({}));
        if (version !== credentialVersion || scratchUsername !== uname || currentCoBlocksToken !== token) return currentCoBlocksToken;
        const verifiedUsername = typeof data.username === 'string' ? data.username : null;
        if (response.status === 401
            || data.noauth === true
            || (response.ok && verifiedUsername?.toLowerCase() !== scratchUsername.toLowerCase())) {
            await clearRejectedCredentials(
                'Your CoBlocks login does not match the current Scratch account. Sign in again.',
                { clearAllTokens: true },
            );
            return null;
        }
        if (response.ok) await chrome.storage.local.set({
            [AUTH_USERNAME_KEY]: verifiedUsername,
            ...(Number.isFinite(data.expiresAt) ? { [`lsTokenExpiresAt.${scratchUsername.toLowerCase()}`]: data.expiresAt } : {}),
        });
    } catch (error) {
        console.warn('Could not verify the CoBlocks account while the server is unavailable:', error);
    }
    return currentCoBlocksToken;
}

async function clearBackendAuthCookies() {
    try {
        const origin = new URL(apiUrl);
        const cookies = await chrome.cookies.getAll({ url: origin.href });
        const ownedCookies = cookies.filter(cookie => /^(coblocks|livescratch|blocklive)[._-]?(auth|session|token)/i.test(cookie.name));
        await Promise.all(ownedCookies.map(cookie => chrome.cookies.remove({
            url: `${cookie.secure ? 'https:' : 'http:'}//${cookie.domain.replace(/^\./, '')}${cookie.path}`,
            name: cookie.name,
            storeId: cookie.storeId,
        })));
    } catch (error) {
        console.warn('Could not clear legacy CoBlocks backend cookies:', error);
    }
}

async function clearRejectedCredentials(
    reason = 'Your CoBlocks login expired. Please sign in again.',
    { clearAllTokens = false } = {},
) {
    if (credentialResetPromise) return credentialResetPromise;
    credentialResetPromise = (async () => {
        const preserveLogin = loginInFlight || verifying || !!await getPendingScratchAuth();
        await Promise.all([
            clearCurrentCoBlocksToken({ clearAllTokens }),
            clearBackendAuthCookies(),
        ]);
        const keepLogin = preserveLogin || loginInFlight || verifying;
        if (!keepLogin) {
            verifying = false;
            verifyError = reason;
            loginInFlight = false;
            loginTabId = null;
            loginState = null;
        }
        try {
            COBLOCKS.onLoggedOut?.({ pendingLogin: keepLogin });
        } catch (error) {
            console.warn('Could not leave active CoBlocks sessions after credential rejection:', error);
        }
        if (!keepLogin) endVerifyCallbacks.splice(0).forEach(callback => callback?.(false, reason));
    })().finally(() => { credentialResetPromise = null; });
    return credentialResetPromise;
}

async function authenticatedFetch(input, init = {}) {
    const requestToken = init.headers?.authorization || init.headers?.Authorization || init.headers?.get?.('authorization');
    const response = await fetch(input, { ...init, credentials: 'omit' });
    try {
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.clone().json() : null;
        if (body?.noauth === true && requestToken && requestToken === currentCoBlocksToken) await clearRejectedCredentials();
    } catch (error) {
        console.warn('Could not inspect a CoBlocks authentication response:', error);
    }
    return response;
}

async function logoutCoBlocks({ waitForServer = true } = {}) {
    const username = uname;
    const token = currentCoBlocksToken;
    await clearCurrentCoBlocksToken();
    await Promise.all([chrome.storage.session.remove('scratchAuthLogin'), chrome.storage.local.remove('scratchAuthLogin')]);
    verifying = false;
    verifyError = null;
    loginInFlight = false;
    loginTabId = null;
    loginState = null;
    try {
        COBLOCKS.onLoggedOut?.();
    } catch (error) {
        console.warn('Could not leave the active CoBlocks session during logout:', error);
    }

    if (username && username !== '*' && token) {
        const serverLogout = fetch(`${apiUrl}/auth/logout`, {
            method: 'POST',
            headers: { authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
            signal: AbortSignal.timeout(5000),
            keepalive: true,
        }).catch(error => console.warn('Server logout failed; the local login was cleared:', error));
        if (waitForServer) await serverLogout;
    }
    return { success: true };
}

async function finishVerification(success, error = null, finishedState = loginState) {
    const pending = await getPendingScratchAuth();
    if (finishedState && pending?.state && pending.state !== finishedState) return;
    if (finishedState && pending?.state === finishedState) {
        await Promise.all([chrome.storage.session.remove('scratchAuthLogin'), chrome.storage.local.remove('scratchAuthLogin')]);
    }
    verifying = false;
    verifyError = error;
    loginInFlight = false;
    loginTabId = null;
    loginState = null;
    endVerifyCallbacks.splice(0).forEach(callback => {
        try { callback?.(success); } catch (callbackError) { console.warn('A sign-in listener disconnected:', callbackError.message); }
    });
}

async function beginScratchAuth() {
    if (loginInFlight) return { started: true };
    loginInFlight = true;
    verifying = true;
    verifyError = null;
    let startedState = null;
    try {
        await backgroundReady;
        await COBLOCKS.refreshUsername(true);
        const response = await fetch(`${apiUrl}/auth/scratch/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json();
        if (!response.ok || !data.url || !data.state) throw new Error(data.err || 'Could not start Scratch Auth.');
        loginState = data.state;
        startedState = data.state;
        const tab = await chrome.tabs.create({ url: 'about:blank' });
        loginTabId = tab.id;
        await chrome.storage.local.set({ scratchAuthLogin: { state: loginState, tabId: loginTabId, apiUrl, createdAt: Date.now() } });
        await chrome.tabs.update(loginTabId, { url: data.url });
        startVerifyCallbacks.splice(0).forEach(callback => callback?.());
        return { started: true };
    } catch (error) {
        await finishVerification(false, error.message, startedState);
        return { err: error.message };
    }
}

async function getPendingScratchAuth() {
    const [local, session] = await Promise.all([
        chrome.storage.local.get('scratchAuthLogin'),
        chrome.storage.session.get('scratchAuthLogin'),
    ]);
    const pending = local.scratchAuthLogin || session.scratchAuthLogin;
    if (!pending) return null;
    if (pending.createdAt && Date.now() - pending.createdAt > 5 * 60_000) return null;
    return pending;
}

async function showScratchAuthSuccess(tabId, username) {
    const successUrl = new URL(chrome.runtime.getURL('auth/success.html'));
    successUrl.searchParams.set('username', username);
    try {
        await chrome.tabs.update(tabId, { url: successUrl.href });
    } catch (error) {
        console.error('Signed in, but could not show the success page:', error);
    }
}

async function exchangeScratchAuthToken(state) {
    for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
            response = await fetch(`${apiUrl}/auth/scratch/finish`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state }), signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            if (attempt === 0) continue;
            throw error;
        }
        const data = await response.json();
        if (!response.ok) {
            if (attempt === 0 && response.status >= 500) continue;
            throw new Error(data.err || 'The server could not finish sign-in.');
        }
        return data;
    }
}

async function completeScratchAuth(tabId, url) {
    const requestedState = new URL(url).searchParams.get('state');
    const saved = await chrome.storage.local.get([AUTH_COMPLETION_KEY, AUTH_USERNAME_KEY]);
    const completed = saved[AUTH_COMPLETION_KEY];
    if (completed?.state === requestedState && completed.apiUrl === apiUrl
        && Date.now() - completed.completedAt < 5 * 60_000
        && saved[AUTH_USERNAME_KEY] === completed.username && await getCoBlocksToken(completed.username)) {
        await showScratchAuthSuccess(tabId, completed.username);
        return { ok: true };
    }
    const stored = await getPendingScratchAuth();
    if (!stored || stored.apiUrl !== apiUrl) return { ok: false, error: 'This login has expired or was cancelled. Start sign-in again from the CoBlocks popup.' };
    const completionUrl = new URL(url);
    const expectedUrl = new URL(`${apiUrl}/auth/scratch/complete`);
    if (completionUrl.origin !== expectedUrl.origin || completionUrl.pathname !== expectedUrl.pathname) return;
    if (completionUrl.searchParams.get('state') !== stored.state) return { ok: false, error: 'This page belongs to an older login. Start sign-in again from the CoBlocks popup.' };
    loginState = stored.state;
    loginTabId = tabId;
    loginInFlight = true;
    verifying = true;
    loginState = null; // Completion is serialized by authCompletionPromise.
    let issuedSession = null;
    let sessionSaved = false;
    try {
        const scratchUsername = await COBLOCKS.refreshUsername(true);
        if (!scratchUsername || scratchUsername === '*') throw new Error('Sign in to Scratch before connecting CoBlocks.');
        const data = await exchangeScratchAuthToken(requestedState);
        if (typeof data.username !== 'string' || typeof data.token !== 'string' || !data.token) throw new Error('Invalid sign-in response from the server.');
        issuedSession = data;
        if (!await COBLOCKS.acceptAuthenticatedUsername?.(data.username)) {
            throw new Error('Scratch Auth account does not match the current Scratch account.');
        }
        if (credentialResetPromise) await credentialResetPromise;
        const pending = await getPendingScratchAuth();
        if (pending?.state !== requestedState) throw new Error('This sign-in was cancelled. Start again from the CoBlocks popup.');
        credentialVersion++;
        currentCoBlocksToken = data.token;
        await chrome.storage.local.set({
            [AUTH_COMPLETION_KEY]: { state: requestedState, username: data.username, apiUrl, completedAt: Date.now() },
            [`lsToken.${data.username.toLowerCase()}`]: data.token,
            [AUTH_USERNAME_KEY]: data.username,
            ...(Number.isFinite(data.expiresAt) ? { [`lsTokenExpiresAt.${data.username.toLowerCase()}`]: data.expiresAt } : {}),
        });
        sessionSaved = true;
        try {
            await COBLOCKS.onAuthenticated?.();
        } catch (error) {
            console.warn('Signed in, but could not refresh active projects:', error);
        }
        await finishVerification(true, null, requestedState);
        await showScratchAuthSuccess(tabId, data.username);
        fetch(`${apiUrl}/auth/scratch/ack`, {
            method: 'POST',
            headers: { authorization: data.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: requestedState }),
            signal: AbortSignal.timeout(5000),
        }).catch(error => console.warn('Could not acknowledge Scratch Auth completion:', error.message));
        return { ok: true };
    } catch (error) {
        if (issuedSession && !sessionSaved) {
            if (currentCoBlocksToken === issuedSession.token) {
                credentialVersion++;
                currentCoBlocksToken = null;
            }
            fetch(`${apiUrl}/auth/logout`, {
                method: 'POST',
                headers: { authorization: issuedSession.token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: issuedSession.username }),
                signal: AbortSignal.timeout(5000),
            }).catch(revokeError => console.warn('Could not revoke an unused sign-in token:', revokeError.message));
        }
        await finishVerification(false, error.message, requestedState);
        return { ok: false, error: error.message };
    }
}

async function handleScratchAuthCompletion(tabId, url) {
    if (!url) return;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return; }
    if (!parsedUrl.pathname.endsWith('/auth/scratch/complete')) return;
    await backgroundReady;
    const expectedUrl = new URL(`${apiUrl}/auth/scratch/complete`);
    if (parsedUrl.origin !== expectedUrl.origin || parsedUrl.pathname !== expectedUrl.pathname) return;
    const state = parsedUrl.searchParams.get('state');
    if (!state) return { ok: false, error: 'The sign-in callback is missing its state.' };
    if (authCompletionPromise) {
        if (authCompletionState === state) return authCompletionPromise;
        await authCompletionPromise;
        return handleScratchAuthCompletion(tabId, url);
    }
    authCompletionState = state;
    authCompletionPromise = completeScratchAuth(tabId, url).finally(() => {
        authCompletionPromise = null;
        authCompletionState = null;
    });
    return authCompletionPromise;
}

function observeScratchAuthCompletion(tabId, url) {
    handleScratchAuthCompletion(tabId, url).catch(error => {
        console.error('Could not complete Scratch Auth:', error);
        verifyError = error.message;
    });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    observeScratchAuthCompletion(tabId, changeInfo.url || tab?.url);
});
chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) observeScratchAuthCompletion(details.tabId, details.url);
});

async function resumeScratchAuth() {
    const stored = await getPendingScratchAuth();
    if (!stored || stored.apiUrl !== apiUrl) return;
    try {
        const tab = await chrome.tabs.get(stored.tabId);
        await handleScratchAuthCompletion(tab.id, tab.url);
    } catch (error) {
        console.warn('Could not resume Scratch Auth:', error);
    }
}


chrome.tabs.onRemoved.addListener(async tabId => {
    if (tabId !== loginTabId || !verifying) return;
    const pending = await getPendingScratchAuth();
    await finishVerification(false, 'Login was cancelled.', pending?.state);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.meta === 'finishScratchAuth') {
        if (!sender.tab?.id || !sender.url) return false;
        handleScratchAuthCompletion(sender.tab.id, sender.url)
            .then(result => sendResponse(result || { ok: false, error: 'This is not the configured CoBlocks sign-in page.' }))
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }
    if (request.meta === 'startScratchAuth') {
        beginScratchAuth().then(sendResponse);
        return true;
    }
    if (request.meta === 'clearCrntToken') {
        clearCurrentCoBlocksToken().then(() => sendResponse('success'));
        return true;
    }
    if (request.meta === 'logoutScratchAuth') {
        logoutCoBlocks({ waitForServer: false })
            .then(sendResponse)
            .catch(error => {
                console.error('Could not log out:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
    if (request.meta === 'getVerifyError') {
        sendResponse(verifyError);
        return false;
    }
});

function handleVerificationRequest(request, sender, sendResponse) {
    if (!sender.url?.startsWith('https://scratch.mit.edu/')) return false;
    if (request.meta === 'startVerifyCallback') {
        if (verifying) sendResponse(); else startVerifyCallbacks.push(sendResponse);
        return true;
    }
    if (request.meta === 'endVerifyCallback') {
        endVerifyCallbacks.push(sendResponse);
        return true;
    }
    if (request.meta === 'verifying') { sendResponse(verifying); return true; }
    if (request.meta === 'getVerifyError') { sendResponse(verifyError); return true; }
    if (request.meta === 'getShowVerifyError') {
        chrome.storage.local.get('dontShowVerifyError').then(data => sendResponse(data.dontShowVerifyError));
        return true;
    }
    if (request.meta === 'dontShowVerifyError') {
        chrome.storage.local.set({ dontShowVerifyError: request.val });
        return true;
    }
}
chrome.runtime.onMessageExternal.addListener(handleVerificationRequest);
chrome.runtime.onMessage.addListener(handleVerificationRequest);


if (chrome.alarms) {
    chrome.alarms.create('coblocks-session-check', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener(async alarm => {
        if (alarm.name !== 'coblocks-session-check') return;
        await backgroundReady;
        if (uname && uname !== '*') await getCurrentCoBlocksTokenAfterUsernameRefresh();
    });
}
