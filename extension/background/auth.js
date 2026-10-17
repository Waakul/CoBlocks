/* exported authenticatedFetch, clearRejectedCredentials, currentCoBlocksToken, getCurrentCoBlocksTokenAfterUsernameRefresh, logoutCoBlocks, resumeScratchAuth */

let currentCoBlocksToken = null;
let verifying = false;
let verifyError = null;
let loginTabId = null;
let loginState = null;
let loginInFlight = false;
let credentialResetPromise = null;
let authCompletionPromise = null;
const endVerifyCallbacks = [];
const startVerifyCallbacks = [];
const AUTH_USERNAME_KEY = 'coblocksAuthUsername';

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
    const rejectedToken = currentCoBlocksToken;
    const stored = await chrome.storage.local.get(null);
    const matchingTokenKeys = Object.entries(stored)
        .filter(([key, value]) => /^(lsToken|blToken)\./.test(key) && (clearAllTokens || value === rejectedToken))
        .map(([key]) => key);
    const usernames = new Set([uname, stored[AUTH_USERNAME_KEY]].filter(username => username && username !== '*'));
    for (const username of usernames) {
        matchingTokenKeys.push(
            `lsToken.${username.toLowerCase()}`,
            `blToken.${username.toLowerCase()}`,
        );
    }
    await chrome.storage.local.remove([...new Set([...matchingTokenKeys, AUTH_USERNAME_KEY])]);
    currentCoBlocksToken = null;
}

async function getCurrentCoBlocksTokenAfterUsernameRefresh() {
    const scratchUsername = uname;
    if (!scratchUsername || scratchUsername === '*') {
        currentCoBlocksToken = null;
        return null;
    }

    const stored = await chrome.storage.local.get(AUTH_USERNAME_KEY);
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
    currentCoBlocksToken = token;
    if (!token) {
        if (authenticatedUsername) await chrome.storage.local.remove(AUTH_USERNAME_KEY);
        return null;
    }

    try {
        const response = await fetch(`${apiUrl}/auth/session`, {
            method: 'POST',
            credentials: 'omit',
            headers: { authorization: token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: scratchUsername }),
        });
        const data = await response.json().catch(() => ({}));
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
        if (response.ok) await chrome.storage.local.set({ [AUTH_USERNAME_KEY]: verifiedUsername });
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
        await Promise.all([
            clearCurrentCoBlocksToken({ clearAllTokens }),
            clearBackendAuthCookies(),
            chrome.storage.session.remove('scratchAuthLogin'),
        ]);
        verifying = false;
        verifyError = reason;
        loginInFlight = false;
        loginTabId = null;
        loginState = null;
        try {
            COBLOCKS.onLoggedOut?.();
        } catch (error) {
            console.warn('Could not leave active CoBlocks sessions after credential rejection:', error);
        }
        endVerifyCallbacks.splice(0).forEach(callback => callback?.(false, reason));
    })().finally(() => { credentialResetPromise = null; });
    return credentialResetPromise;
}

async function authenticatedFetch(input, init = {}) {
    const response = await fetch(input, { ...init, credentials: 'omit' });
    try {
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.clone().json() : null;
        if (body?.noauth === true) await clearRejectedCredentials();
    } catch (error) {
        console.warn('Could not inspect a CoBlocks authentication response:', error);
    }
    return response;
}

async function logoutCoBlocks({ waitForServer = true } = {}) {
    const username = uname;
    const token = currentCoBlocksToken;
    await clearCurrentCoBlocksToken();
    await chrome.storage.session.remove('scratchAuthLogin');
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

function finishVerification(success, error = null) {
    verifying = false;
    verifyError = error;
    loginInFlight = false;
    chrome.storage.session.remove('scratchAuthLogin');
    loginTabId = null;
    loginState = null;
    endVerifyCallbacks.splice(0).forEach(callback => callback?.(success));
}

async function beginScratchAuth() {
    if (loginInFlight) return { started: true };
    loginInFlight = true;
    verifying = true;
    verifyError = null;
    try {
        await backgroundReady;
        await COBLOCKS.refreshUsername(true);
        const response = await fetch(`${apiUrl}/auth/scratch/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await response.json();
        if (!response.ok || !data.url || !data.state) throw new Error(data.err || 'Could not start Scratch Auth.');
        loginState = data.state;
        const tab = await chrome.tabs.create({ url: 'about:blank' });
        loginTabId = tab.id;
        await chrome.storage.session.set({ scratchAuthLogin: { state: loginState, tabId: loginTabId, apiUrl } });
        await chrome.tabs.update(loginTabId, { url: data.url });
        startVerifyCallbacks.splice(0).forEach(callback => callback?.());
        return { started: true };
    } catch (error) {
        finishVerification(false, error.message);
        return { err: error.message };
    }
}

async function completeScratchAuth(tabId, url) {
    const stored = (await chrome.storage.session.get('scratchAuthLogin')).scratchAuthLogin;
    if (!stored || stored.apiUrl !== apiUrl || stored.tabId !== tabId) return;
    const completionUrl = new URL(url);
    const expectedUrl = new URL(`${apiUrl}/auth/scratch/complete`);
    if (completionUrl.origin !== expectedUrl.origin || completionUrl.pathname !== expectedUrl.pathname) return;
    if (completionUrl.searchParams.get('state') !== stored.state) return;
    loginState = stored.state;
    loginTabId = stored.tabId;
    loginInFlight = true;
    verifying = true;
    const requestedState = loginState;
    loginState = null; // consume locally before the HTTP request
    try {
        const response = await fetch(`${apiUrl}/auth/scratch/finish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: requestedState }),
        });
        const data = await response.json();
        if (!response.ok || !data.username || !data.token) throw new Error(data.err || 'Login failed.');
        await COBLOCKS.refreshUsername(true);
        if (!await COBLOCKS.acceptAuthenticatedUsername?.(data.username)) {
            throw new Error('Scratch Auth account does not match the current Scratch account.');
        }
        await chrome.storage.local.set({ [`lsToken.${data.username.toLowerCase()}`]: data.token });
        await chrome.storage.local.set({ [AUTH_USERNAME_KEY]: data.username });
        currentCoBlocksToken = data.token;
        try {
            await COBLOCKS.onAuthenticated?.();
        } catch (error) {
            console.warn('Signed in, but could not refresh active projects:', error);
        }
        finishVerification(true);
        const successUrl = new URL(chrome.runtime.getURL('auth/success.html'));
        successUrl.searchParams.set('username', data.username);
        try {
            await chrome.tabs.update(tabId, { url: successUrl.href });
        } catch (navigationError) {
            console.error('Signed in, but could not show the success page:', navigationError);
        }
    } catch (error) {
        finishVerification(false, error.message);
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
    if (authCompletionPromise) return authCompletionPromise;
    authCompletionPromise = completeScratchAuth(tabId, url).finally(() => { authCompletionPromise = null; });
    return authCompletionPromise;
}

function observeScratchAuthCompletion(tabId, url) {
    handleScratchAuthCompletion(tabId, url).catch(error => {
        console.error('Could not complete Scratch Auth:', error);
        finishVerification(false, error.message);
    });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    observeScratchAuthCompletion(tabId, changeInfo.url || tab?.url);
});
chrome.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) observeScratchAuthCompletion(details.tabId, details.url);
});

async function resumeScratchAuth() {
    const stored = (await chrome.storage.session.get('scratchAuthLogin')).scratchAuthLogin;
    if (!stored || stored.apiUrl !== apiUrl) return;
    try {
        const tab = await chrome.tabs.get(stored.tabId);
        await handleScratchAuthCompletion(tab.id, tab.url);
    } catch (error) {
        console.warn('Could not resume Scratch Auth:', error);
    }
}


chrome.tabs.onRemoved.addListener(tabId => {
    if (tabId === loginTabId && verifying) finishVerification(false, 'Login was cancelled.');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
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
});
