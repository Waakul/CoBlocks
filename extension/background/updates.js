const releasesPage = 'https://github.com/Waakul/CoBlocks/releases';
let updateNoticeQueue = Promise.resolve();

async function claimUpdateNotice(tabId) {
    const stored = await chrome.storage.local.get(['pendingExtensionUpdate', 'extensionUpdateClaim']);
    const update = stored.pendingExtensionUpdate;
    if (!update) return null;
    if (stored.extensionUpdateClaim && Date.now() - stored.extensionUpdateClaim.claimedAt < 30_000) return null;
    await chrome.storage.local.set({ extensionUpdateClaim: { tabId, version: update.version, claimedAt: Date.now() } });
    const release = { title: 'See what’s new in CoBlocks', preview: 'Read the latest release notes on GitHub.', url: `${releasesPage}/latest` };
    try {
        const response = await fetch('https://api.github.com/repos/Waakul/CoBlocks/releases/latest', {
            headers: { Accept: 'application/vnd.github+json' },
            credentials: 'omit',
            signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
            const data = await response.json();
            const url = new URL(data.html_url);
            if (url.origin === 'https://github.com' && url.pathname.startsWith('/Waakul/CoBlocks/releases/tag/')) {
                release.url = url.href;
                release.title = String(data.name || data.tag_name || release.title);
                const notes = String(data.body || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
                    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').trim();
                if (notes) release.preview = notes.length > 320 ? `${notes.slice(0, 320).replace(/\s+\S*$/, '')}…` : notes;
            }
        } else if (response.status === 404) {
            release.url = releasesPage;
        }
    } catch (error) {
        console.warn('Could not fetch CoBlocks release notes:', error.message);
    }
    return { version: update.version, release, releasesPage };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!sender.tab?.id || !sender.url?.startsWith('https://scratch.mit.edu/')) return false;
    if (request.meta === 'getExtensionUpdateNotice') {
        const result = updateNoticeQueue.then(() => claimUpdateNotice(sender.tab.id));
        updateNoticeQueue = result.catch(() => {});
        result.then(sendResponse).catch(error => {
            console.error('Could not prepare the update notice:', error);
            sendResponse(null);
        });
        return true;
    }
    if (request.meta === 'extensionUpdateNoticeShown') {
        const result = updateNoticeQueue.then(async () => {
            const stored = await chrome.storage.local.get(['pendingExtensionUpdate', 'extensionUpdateClaim']);
            if (stored.pendingExtensionUpdate?.version === request.version
                && stored.extensionUpdateClaim?.tabId === sender.tab.id
                && stored.extensionUpdateClaim.version === request.version) {
                await chrome.storage.local.remove(['pendingExtensionUpdate', 'extensionUpdateClaim']);
            }
        });
        updateNoticeQueue = result.catch(() => {});
        result.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;
    }
    return false;
});
