// A page message wakes the worker even when it missed the navigation event.
const heading = document.querySelector('h1');
const status = document.querySelector('p');
const timeout = setTimeout(() => {
    if (status) status.textContent = 'CoBlocks is taking longer than expected. Open the extension popup to check your sign-in status.';
}, 15_000);

chrome.runtime.sendMessage({ meta: 'finishScratchAuth' }, response => {
    clearTimeout(timeout);
    const error = chrome.runtime.lastError?.message || response?.error;
    if (response?.ok) {
        if (status) status.textContent = 'Your login was saved. You can return to Scratch.';
        return;
    }
    if (heading) heading.textContent = 'CoBlocks sign-in needs attention';
    if (status) status.textContent = error || 'Could not finish sign-in. Open the CoBlocks popup and sign in again.';
});
