const username = new URLSearchParams(location.search).get('username');
const usernameElement = document.querySelector('#username');
const statusElement = document.querySelector('#status');

if (username && /^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    usernameElement.textContent = `@${username}`;
}

document.querySelector('#open-scratch').addEventListener('click', () => {
    location.href = 'https://scratch.mit.edu/mystuff/';
});

document.querySelector('#close-tab').addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
        await chrome.tabs.remove(tab.id);
    } else {
        statusElement.textContent = 'You can close this tab now.';
    }
});
