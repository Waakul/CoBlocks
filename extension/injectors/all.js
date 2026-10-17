const badgeScript = document.createElement('script');
badgeScript.className = 'livescratch-ext-2';
badgeScript.dataset.exId = chrome.runtime.id;
badgeScript.dataset.logoUrl = chrome.runtime.getURL('/img/CoBlocksIcon.png');
badgeScript.src = chrome.runtime.getURL('/scripts/badge.js');
(document.head || document.documentElement).appendChild(badgeScript);

// Service-worker requests to scratch.mit.edu may lose cookies when the browser
// blocks third-party cookies. A content script runs in the Scratch tab's site
// context, so it can provide an authoritative session check without exposing
// the Scratch session cookie to CoBlocks.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.meta !== 'getScratchSession') return false;

    fetch('/session/', {
        credentials: 'include',
        cache: 'no-store',
        signal: window.AbortSignal.timeout(8000),
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
        .then(async response => {
            if (!response.ok) throw new Error(`Scratch session returned ${response.status}`);
            sendResponse({ ok: true, session: await response.json() });
        })
        .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
});
