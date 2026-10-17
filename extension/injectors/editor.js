const inviteUrl = new URL(location.href);
const inviteProjectId = inviteUrl.searchParams.get('coblocksProject');
const inviteToken = inviteUrl.searchParams.get('coblocksInvite');
if (inviteProjectId && inviteToken) {
    window.sessionStorage.setItem('coblocksPendingInvite', JSON.stringify({
        projectId: inviteProjectId,
        token: inviteToken,
    }));
    inviteUrl.searchParams.delete('coblocksProject');
    inviteUrl.searchParams.delete('coblocksInvite');
    window.history.replaceState(null, '', inviteUrl);
}

const editorScript = document.createElement('script');
editorScript.className = 'livescratch-ext';
editorScript.dataset.exId = chrome.runtime.id;
editorScript.src = chrome.runtime.getURL('/scripts/editor.js');

function injectEditorScript() {
    const root = document.head || document.documentElement;
    if (!root) return false;
    root.appendChild(editorScript);
    return true;
}

if (!injectEditorScript()) {
    document.addEventListener('readystatechange', injectEditorScript, { once: true });
}
