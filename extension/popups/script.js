async function readFriendsResponse(response) {
    const data = await response.json();
    if (response.status === 401 || data?.noauth) return null;
    if (!response.ok) {
        throw new Error(typeof data?.err === 'string' ? data.err : 'Could not load your friends. Please try again.');
    }
    if (!Array.isArray(data)) throw new Error('The server returned an invalid friends list. Please try again.');
    return data.filter(name => typeof name === 'string');
}

chrome.storage.local.get('theme', (data) => {
    const savedTheme = (data.theme || 'light') + '-mode';
    document.body.classList.replace('light-mode', savedTheme);
});

const defaultApiUrl = 'https://livescratchapi.waakul.com';
const version = chrome.runtime.getManifest().version_name;
document.querySelector('#version').textContent = `v${version}`;

const contents = document.querySelector('#contents');
const friendsList = document.querySelector('#friends-list');
const friends = document.querySelector('#friends');
const addFriendInput = document.querySelector('#add');
const projectsButton = document.querySelector('#projects');
const authDialog = document.querySelector('#not-verified');
const errorDialog = document.querySelector('#error');
const serverUrlField = document.querySelector('#server-url');
const customServerToggle = document.querySelector('#custom-server');
const dialogs = [authDialog, errorDialog];

function updateDialogState() {
    const activeDialog = dialogs.find(dialog => !dialog.hidden);
    const isOpen = Boolean(activeDialog);

    document.body.classList.toggle('dialog-open', isOpen);
    friendsList.inert = isOpen;
    for (const dialog of dialogs) {
        dialog.inert = isOpen && dialog !== activeDialog;
    }

    if (activeDialog) {
        contents.scrollTop = 0;
        const focusTarget = activeDialog.querySelector('button, [href], input, [tabindex="0"]') || activeDialog;
        requestAnimationFrame(() => focusTarget.focus());
    }
}

function showDialog(dialog) {
    for (const otherDialog of dialogs) {
        otherDialog.hidden = otherDialog !== dialog;
    }
    updateDialogState();
}

function hideDialog(dialog) {
    dialog.hidden = true;
    updateDialogState();
}

serverUrlField.defaultValue = defaultApiUrl;

(async function loadServerSettings() {
    const settings = await chrome.storage.local.get(['custom-server', 'server-url']);
    customServerToggle.checked = Boolean(settings['custom-server']);
    serverUrlField.disabled = !customServerToggle.checked;
    serverUrlField.value = settings['server-url'] || defaultApiUrl;
})();

document.querySelector('#switch-theme')?.addEventListener('click', async () => {
    const { theme = 'light' } = await chrome.storage.local.get('theme');
    const newTheme = theme === 'light' ? 'dark' : 'light';
    await chrome.storage.local.set({ theme: newTheme });
    document.body.classList.replace(`${theme}-mode`, `${newTheme}-mode`);
});

let settingsOpen = false;
const settings = document.querySelector('#settings');
const settingsToggle = document.querySelector('#settings-dropdown');
settings.style.display = 'none';

function toggleSettings() {
    settingsOpen = !settingsOpen;
    settings.style.display = settingsOpen ? 'flex' : 'none';
    settingsToggle.setAttribute('aria-expanded', String(settingsOpen));
    if (settingsOpen) {
        requestAnimationFrame(() => settingsToggle.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
}
settingsToggle?.addEventListener('click', toggleSettings);
settingsToggle?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSettings();
    }
});

projectsButton.addEventListener('click', () => {
    chrome.tabs.create({ url: '/projects/index.html' });
});

function isValidServerUrl(value) {
    return /^(https?:\/\/)([a-zA-Z0-9.-]+)(:[0-9]{1,5})\/?$/.test(value);
}

document.querySelectorAll('button.credit').forEach(credit => {
    credit.onclick = () => {
        chrome.tabs.create({ url: `${credit.id}?ref=coblocks-extension` });
    };
});

chrome.runtime.sendMessage({ meta: 'getUsernamePlus', forceRefresh: true }, async info => {
    if (!info) return;

    let username = info.uname;
    let token = info.currentCoBlocksToken;
    const apiUrl = info.apiUrl;
    const authAccount = document.querySelector('#auth-account');
    const authUsername = document.querySelector('#auth-username');
    const logoutButton = document.querySelector('#logout');
    if (token) {
        authAccount.hidden = false;
        authUsername.textContent = `@${username}`;
    }

    logoutButton?.addEventListener('click', async () => {
        const status = document.querySelector('#logout-status');
        logoutButton.disabled = true;
        logoutButton.textContent = 'Logging out...';
        status.textContent = '';
        authAccount.hidden = true;
        showDialog(authDialog);
        try {
            const result = await chrome.runtime.sendMessage({ meta: 'logoutScratchAuth' });
            if (!result?.success) throw new Error(result?.error || 'Could not log out.');
            location.reload();
        } catch (error) {
            hideDialog(authDialog);
            authAccount.hidden = false;
            status.textContent = error.message || 'Could not log out.';
            logoutButton.disabled = false;
            logoutButton.textContent = 'Log out';
        }
    });

    async function saveServerSetting(enabled, url) {
        await chrome.storage.local.set({ 'custom-server': enabled, 'server-url': url });
        await chrome.storage.local.remove([
            `lsToken.${username?.toLowerCase()}`,
            `blToken.${username?.toLowerCase()}`,
            'coblocksAuthUsername',
        ]);
        await chrome.storage.local.set({ apiUpdateReload: true });
        chrome.runtime.reload();
    }
    function requestServerPermission(enabled, url) {
        if (!enabled) return void saveServerSetting(false, url);
        if (!isValidServerUrl(url)) {
            serverUrlField.setCustomValidity('Enter a valid server URL.');
            serverUrlField.reportValidity();
            customServerToggle.checked = false;
            return;
        }
        serverUrlField.setCustomValidity('');
        chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }, granted => {
            if (granted) saveServerSetting(true, url);
            else customServerToggle.checked = false;
        });
    }
    customServerToggle.addEventListener('change', () => {
        serverUrlField.disabled = !customServerToggle.checked;
        requestServerPermission(customServerToggle.checked, serverUrlField.value.trim());
    });
    serverUrlField.addEventListener('change', () => {
        if (customServerToggle.checked) requestServerPermission(true, serverUrlField.value.trim());
    });

    function updateSignedInState(account) {
        if (account.signedin) {
            document.querySelector('#loggedout').style.display = 'none';
            contents.style.display = 'flex';
            token = account.currentCoBlocksToken;
            username = account.uname;
        } else {
            document.querySelector('#loggedout').style.display = 'flex';
            contents.style.display = 'none';
        }
    }
    updateSignedInState(info);

    const addedFriends = new Set();

    function addFriendGUI(name) {
        const normalizedName = name?.toLowerCase();
        if (!normalizedName || addedFriends.has(normalizedName)) return;
        addedFriends.add(normalizedName);

        const item = document.createElement('li');
        item.dataset.username = name;

        const profile = document.createElement('span');
        profile.className = 'button';
        profile.textContent = `@${name}`;

        const removeButton = document.createElement('span');
        removeButton.className = 'material-symbols-outlined x button';
        removeButton.textContent = 'remove';

        item.append(profile, removeButton);
        item.onclick = event => {
            if (event.target?.classList?.contains('x')) {
                removeFriend(name);
                projectsButton.style.opacity = 1;
                return;
            }
            chrome.tabs.create({ url: `https://scratch.mit.edu/users/${name}` });
        };
        item.onmouseenter = () => projectsButton.style.opacity = 0.5;
        item.onmouseleave = () => projectsButton.style.opacity = 1;
        friends.appendChild(item);
    }

    async function addFriend(name) {
        const trimmedName = name.trim();
        const normalizedName = trimmedName.toLowerCase();
        if (!trimmedName || trimmedName.includes(' ') || normalizedName === username.toLowerCase() || addedFriends.has(normalizedName)) return;

        addFriendInput.value = '';
        const response = await fetch(`${apiUrl}/friends/${username}/${trimmedName}`, {
            method: 'POST',
            headers: { authorization: token },
        });
        if (response.ok) {
            addFriendGUI(trimmedName);
        } else {
            alert('That Scratch user has not joined CoBlocks yet!');
        }
    }

    function removeFriend(name) {
        addedFriends.delete(name.toLowerCase());
        for (const child of friends.children) {
            if (child.dataset.username === name) {
                child.remove();
                break;
            }
        }
        fetch(`${apiUrl}/friends/${username}/${name}`, { method: 'DELETE', headers: { authorization: token } });
    }

    addFriendInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') addFriend(addFriendInput.value);
    });

    document.querySelector('#submit').onclick = () => addFriend(addFriendInput.value);

    if (!info.currentCoBlocksToken) {
        showNoAuthMessage();
        const reason = await chrome.runtime.sendMessage({ meta: 'getVerifyError' });
        if (reason) document.querySelector('#scratch-auth-status').textContent = reason;
    } else {
        try {
            const response = await fetch(`${apiUrl}/friends/${username}`, { headers: { authorization: token } });
            const list = await readFriendsResponse(response);
            if (list === null) showNoAuthMessage();
            else {
                friends.replaceChildren();
                list.forEach(addFriendGUI);
            }
        } catch (error) {
            showDialog(errorDialog);
            const message = error.stack || error.message || String(error);
            document.querySelector('#error-content').textContent = message.split(chrome.runtime.getURL('')).join('');
        }
    }

    if (token) {
        try {
            const response = await fetch(`${apiUrl}/privateMe/${username}`, { headers: { authorization: token } });
            if (response.ok) {
                const privacy = await response.json();
                if (typeof privacy === 'boolean') document.querySelector('#privme').checked = privacy;
            }
        } catch (error) {
            console.warn('Could not load CoBlocks privacy settings:', error);
        }
    }

    document.querySelector('#privme')?.addEventListener('change', event => {
        fetch(`${apiUrl}/privateMe/${username}/${event.currentTarget.checked}`, {
            method: 'PUT',
            headers: { authorization: token },
        });
    });
});

function showNoAuthMessage() {
    showDialog(authDialog);
}

document.querySelector('#scratch-auth-login')?.addEventListener('click', async () => {
    const button = document.querySelector('#scratch-auth-login');
    const status = document.querySelector('#scratch-auth-status');
    button.disabled = true;
    status.textContent = 'Opening Scratch Auth…';
    try {
        const result = await chrome.runtime.sendMessage({ meta: 'startScratchAuth' });
        if (result?.err) throw new Error(result.err);
        status.textContent = 'Complete the sign in in the new tab, then return here.';
    } catch (error) {
        status.textContent = error.message || 'Could not start sign in.';
        button.disabled = false;
    }
});

document.getElementById('link-github').onclick = () => {
    chrome.tabs.create({ url: 'https://github.com/Waakul/CoBlocks' });
};
document.getElementById('link-discord').onclick = () => {
    chrome.tabs.create({ url: 'https://discord.gg/mhDzvrX4RD' });
};
document.getElementById('link-donate').onclick = () => {
    chrome.tabs.create({ url: 'https://ko-fi.com/waakul' });
};

const notificationsToggle = document.querySelector('#notifs');
const pingSoundsToggle = document.querySelector('#ping-sounds');
const badgesToggle = document.querySelector('#badges');
const editorThemeToggle = document.querySelector('#editor-follows-theme');

(async function loadPreferences() {
    const preferences = await chrome.storage.local.get(['notifs', 'ping', 'badges', 'editorFollowsTheme']);
    notificationsToggle.checked = preferences.notifs ?? false;
    pingSoundsToggle.checked = preferences.ping ?? false;
    badgesToggle.checked = !(preferences.badges ?? false);
    editorThemeToggle.checked = preferences.editorFollowsTheme === true;
})();

notificationsToggle.addEventListener('change', event => {
    const enabled = event.currentTarget.checked;
    chrome.storage.local.set({ notifs: enabled });
    if (!enabled) return;

    chrome.permissions.request({
        permissions: ['notifications'],
    }, granted => {
        if (!granted) {
            chrome.storage.local.set({ notifs: false });
            notificationsToggle.checked = false;
        }
    });
});

pingSoundsToggle.addEventListener('change', event => {
    chrome.storage.local.set({ ping: event.currentTarget.checked });
});

editorThemeToggle.addEventListener('change', event => {
    chrome.storage.local.set({ editorFollowsTheme: event.currentTarget.checked });
});

badgesToggle.addEventListener('change', event => {
    chrome.storage.local.set({ badges: !event.currentTarget.checked });
});


chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const signedOut = Object.entries(changes).some(([key, change]) =>
        (key.startsWith('lsToken.') || key === 'coblocksAuthUsername') && change.oldValue && !change.newValue,
    );
    if (signedOut) location.reload();
});
