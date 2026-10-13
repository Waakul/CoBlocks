chrome.storage.local.get('theme', (data) => {
    const savedTheme = (data.theme || 'light') + '-mode';
    document.querySelector('body').classList.replace('light-mode', savedTheme);
});

var version = chrome.runtime.getManifest().version_name;
document.querySelector('#version').innerHTML = 'v'+version;

document.getElementById('server-url').defaultValue = 'https://livescratchapi.waakul.com';

{
    (async () => {
        const data = await chrome.storage.local.get('custom-server');
        const value = data['custom-server'];

        document.getElementById('server-url').disabled = !value;
        document.getElementById('custom-server').checked = !!value;
    })();
}
{
    (async () => {
        const data = await chrome.storage.local.get('server-url');
        const serverUrlValue = data['server-url'];

        document.getElementById('server-url').value = serverUrlValue || 'https://livescratchapi.waakul.com';
    })();
}

document.getElementById('switch-theme')?.addEventListener('click', function(){
    chrome.storage.local.get('theme', (data) => {
        let theme = data['theme'] || 'light';
        let newTheme = theme == 'light' ? 'dark' : 'light';
        chrome.storage.local.set({'theme': newTheme});
        document.querySelector('body').classList.replace(`${theme}-mode`, `${newTheme}-mode`);
    });
});

let settingsDropdown = false;
document.getElementById('settings').style.display = settingsDropdown ? 'flex' : 'none';
document.getElementById('settings-dropdown')?.addEventListener('click', function() {
    settingsDropdown = !settingsDropdown;
    console.log(settingsDropdown);
    document.getElementById('settings').style.display = settingsDropdown ? 'flex' : 'none';
});

document.querySelector('button#projects')?.addEventListener('click', function () {
    chrome.tabs.create({
        url: '/projects/index.html',
    });
});

function validateUrl(input) {
    const value = input.value;
    const regex = new RegExp('^(https?:\/\/)([a-zA-Z0-9.-]+)(:[0-9]{1,5})?$');
    return regex.test(value);
}

document.querySelectorAll('button.credit').forEach(function(credit){
    credit.onclick = () => {
        chrome.tabs.create({
            url: `${credit.id}?ref=livescratch-extension`,
        });
    };
});   

chrome.runtime.sendMessage({ meta: 'getUsernamePlus', forceRefresh: true }, function (info) {
    if (!info) return;
    let username = info.uname;
    let token = info.currentLsToken;
    let apiUrl = info.apiUrl;
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
        logoutButton.textContent = 'Logging out…';
        status.textContent = '';
        try {
            const result = await chrome.runtime.sendMessage({ meta: 'logoutScratchAuth' });
            if (!result?.success) throw new Error('Could not log out.');
            location.reload();
        } catch (error) {
            status.textContent = error.message || 'Could not log out.';
            logoutButton.disabled = false;
            logoutButton.textContent = 'Log out';
        }
    });

    const customServer = document.querySelector('input#custom-server');
    const serverUrlField = document.getElementById('server-url');
    async function saveServerSetting(enabled, url) {
        await chrome.storage.local.set({ 'custom-server': enabled, 'server-url': url });
        await chrome.storage.local.remove([`lsToken.${username?.toLowerCase()}`, `blToken.${username?.toLowerCase()}`]);
        await chrome.storage.local.set({ apiUpdateReload: true });
        chrome.runtime.reload();
    }
    function requestServerPermission(enabled, url) {
        if (!enabled) return void saveServerSetting(false, url);
        if (!validateUrl({ value: url })) {
            serverUrlField.setCustomValidity('Enter a valid server URL.');
            serverUrlField.reportValidity();
            customServer.checked = false;
            return;
        }
        serverUrlField.setCustomValidity('');
        chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }, granted => {
            if (granted) saveServerSetting(true, url);
            else customServer.checked = false;
        });
    }
    customServer?.addEventListener('change', () => {
        serverUrlField.disabled = !customServer.checked;
        requestServerPermission(customServer.checked, serverUrlField.value.trim());
    });
    serverUrlField?.addEventListener('change', () => {
        if (customServer.checked) requestServerPermission(true, serverUrlField.value.trim());
    });

    function setSignedin(info) {

        if (info.signedin) {
            document.querySelector('#loggedout').style.display = 'none';
            document.querySelector('#contents').style.display = 'flex';
            token = info.currentLsToken;
            username = info.uname;
        } else {
            document.querySelector('#loggedout').style.display = 'flex';
            document.querySelector('#contents').style.display = 'none';
        }
    }
    setSignedin(info);

    let alreadyAdded = {};

    // credit https://stackoverflow.com/questions/2794137/sanitizing-user-input-before-adding-it-to-the-dom-in-javascript
    function sanitize(string) {
        string = String(string);
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            '\'': '&#x27;',
            '/': '&#x2F;',
        };
        const reg = /[&<>"'/]/ig;
        return string.replace(reg, (match) => (map[match]));
    }

    function addFriendGUI(name) {
        if (name?.toLowerCase() in alreadyAdded) { return; }
        alreadyAdded[name.toLowerCase()] = true;

        let item = document.createElement('li');
        item.username = name;
        item.innerHTML = `<span class="button">@${sanitize(name)}</span><span class="material-symbols-outlined x button">remove</span>`;
        item.onclick = (e) => {
            if (e.target?.classList?.contains('x')) {
                removeFriend(name); 
                document.querySelector('#projects').style.opacity = 1;
            }
            else { chrome.tabs.create({ url: `https://scratch.mit.edu/users/${name}` }); }
        };
        item.onmouseenter = (e) => {
            document.querySelector('#projects').style.opacity = 0.5;
        };
        item.onmouseleave = (e) => {
            document.querySelector('#projects').style.opacity = 1;
        };
        document.querySelector('#friends').appendChild(item);
    }

    async function addFriend(name) {
        if (name.toLowerCase() in alreadyAdded) { return; }
        if (name.toLowerCase() == username.toLowerCase()) { return; }
        if (!name.trim()) { return; }
        if (name.includes(' ')) { return; }
        document.querySelector('#add').value = '';
        
        let response = await fetch(`${apiUrl}/friends/${username}/${name}`, { method: 'POST', headers: { authorization: token } });
        let statusCode = response.status;
        if (statusCode===200) {
            addFriendGUI(name);
        } else {
            alert('The user you tried to friend doesnt have livescratch!');
        }
    }

    function removeFriend(name) {
        delete alreadyAdded[name.toLowerCase()];
        for (let child of document.querySelector('#friends').children) {
            if (child.username == name) { child.remove(); break; }
        }
        fetch(`${apiUrl}/friends/${username}/${name}`, { method: 'DELETE', headers: { authorization: token } });
    }

    document.querySelector('#add')?.addEventListener('keyup', function (event) {
        if (event.keyCode === 13) {
            addFriend(document.querySelector('#add').value);
        }
    });

    document.querySelector('#submit').onclick = () => { addFriend(document.querySelector('#add').value); };

    if (!info.currentLsToken) {
        showNoAuthMessage();
    } else {
        fetch(`${apiUrl}/friends/${username}`, { headers: { authorization: token } })
            .then((res) => { document.querySelector('#friends').innerHTML = ''; return res; })
            .then(res => res.json().then(list => {
                if (list.noauth) { showNoAuthMessage(); }
                else { list.forEach(addFriendGUI); }
            }))
            .catch((e) => {
                document.querySelector('#error').style.display = 'inherit';
                document.querySelector('#error-content').innerHTML = e.stack.replace(new RegExp(`chrome-extension://${chrome.runtime.id}/`, 'g'), '');
            });
    }

    {
        (async () => {
            if (token) document.querySelector('#privme').checked = await (await fetch(`${apiUrl}/privateMe/${username}`, { headers: { authorization: token } })).json();
        })();
    }

    document.querySelector('#privme')?.addEventListener('change', (event) => {
        let on = event.currentTarget.checked;

        fetch(`${apiUrl}/privateMe/${username}/${on}`, {method:'put', headers: { authorization: token }  });
    });
});

function showNoAuthMessage() {
    document.querySelector('#not-verified').style.display = 'inherit';
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

document.getElementById('link-uptime').onclick = () => {
    chrome.tabs.create({ url: 'https://status.uptime-monitor.io/67497373f98a6334aaea672d' });
};
document.getElementById('link-donate').onclick = () => {
    chrome.tabs.create({ url: 'https://ko-fi.com/waakul' });
};

(async () => {
    document.querySelector('#notifs').checked = (await chrome.storage.local.get(['notifs']))?.notifs ?? false;
})();

document.querySelector('#notifs')?.addEventListener('change', (event) => {
    let on = event.currentTarget.checked;
    chrome.storage.local.set({ notifs: on });
    // Permissions must be requested from inside a user gesture, like a button's
    // click handler.
    chrome.permissions.request({
        permissions: ['notifications'],
    }, (granted) => {
        // The callback argument will be true if the user granted the permissions.
        console.log(granted);
        if(!granted) {
            chrome.storage.local.set({ notifs: false });
            document.querySelector('#notifs').checked = false;
        }
    });
});

(async () => {
    document.querySelector('#ping-sounds').checked = (await chrome.storage.local.get(['ping']))?.ping ?? false;
    document.querySelector('#badges').checked = !((await chrome.storage.local.get(['badges']))?.badges ?? false);
})();

document.querySelector('#ping-sounds')?.addEventListener('change', (event) => {
    let on = event.currentTarget.checked;
    chrome.storage.local.set({ ping: on });
    // Permissions must be requested from inside a user gesture, like a button's
    // click handler.
});

document.querySelector('#badges')?.addEventListener('change', (event) => {
    let on = event.currentTarget.checked;
    chrome.storage.local.set({ badges: !on });
});
