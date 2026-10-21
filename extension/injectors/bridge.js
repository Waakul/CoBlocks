// This preference is opt-in. Keep Scratch and other extensions' themes intact.
const editorThemePreferences = { theme: 'light', editorFollowsTheme: false };
const changedEditorThemeKeys = new Set();
function applyEditorTheme() {
    if (editorThemePreferences.editorFollowsTheme === true) {
        document.documentElement.dataset.coblocksTheme = editorThemePreferences.theme === 'dark' ? 'dark' : 'light';
    } else {
        delete document.documentElement.dataset.coblocksTheme;
    }
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.theme && !changes.editorFollowsTheme)) return;
    for (const key of ['theme', 'editorFollowsTheme']) {
        if (!changes[key]) continue;
        changedEditorThemeKeys.add(key);
        editorThemePreferences[key] = changes[key].newValue;
    }
    applyEditorTheme();
});
chrome.storage.local.get(['theme', 'editorFollowsTheme'], preferences => {
    for (const key of ['theme', 'editorFollowsTheme']) {
        if (!changedEditorThemeKeys.has(key)) editorThemePreferences[key] = preferences[key];
    }
    applyEditorTheme();
});

/* exported injectCoBlocksPageScript */
const pageBridgeChannel = crypto.randomUUID();
const pageBridgePorts = new Map();
const queuedPageScripts = [];
let pageRuntimeReady = false;

function postToPage(message) {
    window.postMessage(JSON.stringify({ channel: pageBridgeChannel, direction: 'extension', ...message }), location.origin);
}

window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message?.channel !== pageBridgeChannel || message.direction !== 'page') return;
    if (message.type === 'clipboard') {
        if (typeof message.text !== 'string') return;
        navigator.clipboard.writeText(message.text)
            .then(() => postToPage({ type: 'response', id: message.id }))
            .catch(error => postToPage({ type: 'response', id: message.id, error: error.message }));
    } else if (message.type === 'request') {
        chrome.runtime.sendMessage(message.request, response => {
            postToPage({ type: 'response', id: message.id, response, error: chrome.runtime.lastError?.message });
        });
    } else if (message.type === 'connect') {
        const port = chrome.runtime.connect({ name: 'scratch-editor' });
        pageBridgePorts.set(message.id, port);
        port.onMessage.addListener(data => postToPage({ type: 'port-message', id: message.id, data }));
        port.onDisconnect.addListener(() => {
            postToPage({ type: 'port-disconnect', id: message.id, error: chrome.runtime.lastError?.message });
            pageBridgePorts.delete(message.id);
        });
    } else if (message.type === 'port-message') {
        pageBridgePorts.get(message.id)?.postMessage(message.data);
    } else if (message.type === 'port-disconnect') {
        pageBridgePorts.get(message.id)?.disconnect();
        pageBridgePorts.delete(message.id);
    }
});

function injectCoBlocksPageScript(script) {
    if (pageRuntimeReady) (document.head || document.documentElement).appendChild(script);
    else queuedPageScripts.push(script);
}

function loadPageRuntime() {
    const root = document.head || document.documentElement;
    if (!root) {
        document.addEventListener('readystatechange', loadPageRuntime, { once: true });
        return;
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('scripts/runtime.js');
    script.dataset.channel = pageBridgeChannel;
    script.onload = () => {
        pageRuntimeReady = true;
        queuedPageScripts.splice(0).forEach(queued => root.appendChild(queued));
    };
    root.appendChild(script);
}

chrome.runtime.sendMessage({ meta: 'scratchBridgeReady' }, () => {
    if (chrome.runtime.lastError) {
        console.error('Could not initialize CoBlocks:', chrome.runtime.lastError.message);
        return;
    }
    loadPageRuntime();
});
