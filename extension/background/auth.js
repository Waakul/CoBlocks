let currentLsToken = null;
let verifying = false;
let verifyError = null;
let loginTabId = null;
let loginState = null;
let loginInFlight = false;
const endVerifyCallbacks = [];
const startVerifyCallbacks = [];

async function getLivescratchToken(username) {
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

async function getCurrentLsToken() {
    const username = await LIVESCRATCH.refreshUsername();
    currentLsToken = await getLivescratchToken(username);
    return currentLsToken;
}

async function getCurrentLSTokenAfterUsernameRefresh() {
    currentLsToken = await getLivescratchToken(uname);
    return currentLsToken;
}

function storeLivescratchToken(username, token, current = false) {
    if (!username || username === '*') return;
    chrome.storage.local.set({ [`lsToken.${username.toLowerCase()}`]: token });
    if (current) currentLsToken = token;
}

async function clearCurrentLsToken() {
    if (uname && uname !== '*') {
        await chrome.storage.local.remove([
            `lsToken.${uname.toLowerCase()}`,
            `blToken.${uname.toLowerCase()}`,
        ]);
    }
    currentLsToken = null;
}

async function logoutLivescratch({ waitForServer = true } = {}) {
    const username = uname;
    const token = currentLsToken;
    await clearCurrentLsToken();
    await chrome.storage.session.remove('scratchAuthLogin');
    verifying = false;
    verifyError = null;
    loginInFlight = false;
    loginTabId = null;
    loginState = null;
    LIVESCRATCH.onLoggedOut?.();

    if (username && username !== '*' && token) {
        const serverLogout = fetch(`${apiUrl}/auth/logout`, {
                method: 'POST',
                headers: { authorization: token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
                signal: AbortSignal.timeout(5000),
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
        await LIVESCRATCH.refreshUsername(true);
        const response = await fetch(`${apiUrl}/auth/scratch/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const data = await response.json();
        if (!response.ok || !data.url || !data.state) throw new Error(data.err || 'Could not start Scratch Auth.');
        loginState = data.state;
        const tab = await chrome.tabs.create({ url: data.url });
        loginTabId = tab.id;
        await chrome.storage.session.set({ scratchAuthLogin: { state: loginState, tabId: loginTabId, apiUrl } });
        startVerifyCallbacks.splice(0).forEach(callback => callback?.());
        return { started: true };
    } catch (error) {
        finishVerification(false, error.message);
        return { err: error.message };
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (!loginState) {
        const stored = (await chrome.storage.session.get('scratchAuthLogin')).scratchAuthLogin;
        if (stored?.apiUrl === apiUrl) {
            loginState = stored.state;
            loginTabId = stored.tabId;
            loginInFlight = true;
            verifying = true;
        }
    }
    if (tabId !== loginTabId || !changeInfo.url || !loginState) return;
    const completeUrl = `${apiUrl}/auth/scratch/complete`;
    if (!changeInfo.url.startsWith(completeUrl)) return;
    const state = new URL(changeInfo.url).searchParams.get('state');
    if (state !== loginState) return;
    const requestedState = loginState;
    loginState = null; // consume locally before the HTTP request
    try {
        const response = await fetch(`${apiUrl}/auth/scratch/finish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: requestedState }),
        });
        const data = await response.json();
        if (!response.ok || !data.username || !data.token) throw new Error(data.err || 'Login failed.');
        await LIVESCRATCH.refreshUsername(true);
        if (uname.toLowerCase() !== data.username.toLowerCase()) throw new Error('Scratch Auth account does not match the current Scratch account.');
        await chrome.storage.local.set({ [`lsToken.${data.username.toLowerCase()}`]: data.token });
        currentLsToken = data.token;
        await LIVESCRATCH.onAuthenticated?.();
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
});

chrome.tabs.onRemoved.addListener(tabId => {
    if (tabId === loginTabId && verifying) finishVerification(false, 'Login was cancelled.');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.meta === 'startScratchAuth') {
        beginScratchAuth().then(sendResponse);
        return true;
    }
    if (request.meta === 'clearCrntToken') {
        clearCurrentLsToken().then(() => sendResponse('success'));
        return true;
    }
    if (request.meta === 'logoutScratchAuth') {
        logoutLivescratch().then(sendResponse);
        return true;
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
