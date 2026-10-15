// monkey-patch before importing socket.io.js
self.addEventListener = (function (original) {
    return function (type, listener, options) {
        if (type === 'beforeunload') {
            console.warn('Ignoring \'beforeunload\' listener in service worker context.');
            return;
        }
        return original.call(self, type, listener, options);
    };
})(self.addEventListener);

importScripts('background/socket.io.js', 'background/livescratchProject.js', 'background/auth.js');

const API_PREFIX = '/apiv2';
const RECOVERY_DB_NAME = 'LiveScratchRecovery';
const RECOVERY_DB_VERSION = 1;

function openRecoveryDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'key' });
            if (!db.objectStoreNames.contains('links')) db.createObjectStore('links', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const recoveryIdentity = () => String(uname || '').trim().toLowerCase();
const recoveryKey = id => `${recoveryIdentity()}:${String(id)}`;

function isValidProjectJson(json) {
    let parsed = json;
    if (typeof json === 'string') {
        if (!json.trim()) return false;
        try { parsed = JSON.parse(json); } catch { return false; }
    }
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.targets) && parsed.targets.every(target => target && typeof target === 'object' && typeof target.isStage === 'boolean');
}

async function recoveryPut(storeName, value) {
    if (!recoveryIdentity() || recoveryIdentity() === '*') return false;
    const db = await openRecoveryDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = () => { db.close(); resolve(true); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
}

async function recoveryGet(storeName, key) {
    if (!recoveryIdentity() || recoveryIdentity() === '*') return null;
    const db = await openRecoveryDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
    });
}

async function saveLocalProjectSnapshot(lsId, scratchId, json, version) {
    if (!lsId || !isValidProjectJson(json)) return false;
    const identity = recoveryIdentity();
    await recoveryPut('projects', {
        key: recoveryKey(lsId),
        identity,
        lsId: String(lsId),
        scratchId: scratchId ? String(scratchId) : null,
        json,
        version: Number.isFinite(Number(version)) ? Number(version) : 0,
        savedAt: Date.now(),
    });
    if (scratchId) {
        await recoveryPut('links', {
            key: recoveryKey(scratchId),
            identity,
            scratchId: String(scratchId),
            lsId: String(lsId),
            savedAt: Date.now(),
        });
    }
    return true;
}

async function getLocalProjectSnapshot(lsId) {
    return recoveryGet('projects', recoveryKey(lsId));
}

async function getLocalProjectLink(scratchId) {
    return recoveryGet('links', recoveryKey(scratchId));
}

function addApiPrefix(serverUrl) {
    const url = new URL(serverUrl);
    const cleanPath = url.pathname.replace(/\/$/, '');
    url.pathname = cleanPath.endsWith(API_PREFIX) ? cleanPath : `${cleanPath}${API_PREFIX}`;
    return url.href.replace(/\/$/, '');
}

const getStorageValue = (key) => {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(key, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result[key]);
            }
        });
    });
};

const getApiUrl = async () => {
    const customServer = await getStorageValue('custom-server');

    if (customServer) {
        const serverUrl = await getStorageValue('server-url');
        return addApiPrefix(serverUrl || 'https://livescratchapi.waakul.com');
    }

    return addApiPrefix('https://livescratchapi.waakul.com');
};

let apiUrl;

const loadUrl = () => {
    return new Promise(async (resolve, reject) => {
        try {
            apiUrl = await getApiUrl();
            resolve(); // Ensure this is final
        } catch (error) {
            console.error('Failed to get the API URL:', error);
            apiUrl = addApiPrefix('https://livescratchapi.waakul.com');
            reject(error); // Only reject on actual failure
        }
    });
};

loadUrl().then(()=>{
    backgroundScript();
})
    .catch((error)=>{
        console.error('Error loading server URL', error);
    });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.meta === 'getAPI-URL') {
        sendResponse({apiURL: apiUrl});
        return false;
    }
    return false;
});

/// DECS
let uname = '*';
let upk = undefined;

chrome.runtime.onInstalled.addListener(async (details) => {
    let { apiUpdateReload } = await chrome.storage.local.get('apiUpdateReload'); // Destructure the result
    apiUpdateReload = await { apiUpdateReload }['apiUpdateReload'];
    console.log(apiUpdateReload);

    if (!!apiUpdateReload) {
        await chrome.storage.local.set({ 'apiUpdateReload': false });
        return;
    }

    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: 'https://ko-fi.com/waakul' });
        chrome.tabs.create({ url: 'https://livescratch.waakul.com' });
    } else if (details.reason === chrome.runtime.OnInstalledReason.UPDATE) {
        chrome.tabs.create({ url: 'https://livescratch.waakul.com' /* 'https://livescratch.waakul.com/new-release' */ });
    }
});


const LIVESCRATCH = {};
async function backgroundScript() {

    // user info
    // let username = 'ilhp10'

    // let apiUrl = 'http://127.0.0.1:4000'

    ////////// ACTIVE PROJECTS DATABASE //////////
    // lsId -> [ports...]
    let livescratchTabs = {};
    // lsId -> LivescratchProject
    let projects = {};
    // portName -> lsId
    let portIds = {};

    let lastPortId = 0;
    let ports = [];

    LIVESCRATCH.onAuthenticated = async () => {
        ports.forEach(port => { try { port.postMessage({ meta: 'resync' }); } catch (error) { console.error(error); } });
        const ids = Object.keys(livescratchTabs);
        if (socket.connected && ids.length) socket.send({ type: 'joinSessions', username: uname, pk: upk, ids, token: currentLsToken });
    };

    LIVESCRATCH.onLoggedOut = () => {
        Object.keys(livescratchTabs).forEach(id => {
            if (socket.connected) socket.send({ type: 'leaveSession', id });
        });
    };

    let newProjects = {}; // tabId (or 'newtab') -> lsId
    let tabCallbacks = {}; // tabId -> callback function

    function getProjectId(url) {
        if (projectsPageTester.test(url)) {
            let id = new URL(url).pathname.split('/')[2];
            // dont redirect if is not /projects/id/...
            if (isNaN(parseFloat(id))) {
                return null;
            } else {
                return id;
            }
        } else {
            return null;
        }
    }

    async function handleNewProject(tab) {
        let id = getProjectId(tab.url);
        if (!!id && tab.id in newProjects) {
            let lsId = newProjects[tab.id];
            delete newProjects[tab.id];
            authenticatedFetch(`${apiUrl}/linkScratch/${id}/${lsId}/${uname}`, {
                method: 'PUT',
                headers: { authorization: currentLsToken },
            }); // link scratch project with api
            tabCallbacks[tab.id]({ meta: 'initLivescratch', lsId }); // init livescratch in project tab
        }
    }

    const newProjectPage = 'https://scratch.mit.edu/create';
    async function prepRedirect(tab) {
        if (uname == '*') { return false; }
        let id = getProjectId(tab.url);


        // dont redirect if is not /projects/id/...
        if (!id) { return false; }
        let info = await (await authenticatedFetch(apiUrl + `/userRedirect/${id}/${uname}`, { headers: { authorization: currentLsToken } })).json();
        // dont redirect if scratch id is not associated with ls project
        if (info.goto == 'none') { return false; }
        // dont redirect if already on project
        if (info.goto == id) { return false; }

        if (info.goto == 'new') {
            //register callbacks and redirect
            newProjects[tab.id] = info.lsId; //TODO: send this with api
            return newProjectPage;
        } else {
            if (tab.url.endsWith('editor') || tab.url.endsWith('editor/')) {
                return `https://scratch.mit.edu/projects/${info.goto}/editor`;
            } else {
                return `https://scratch.mit.edu/projects/${info.goto}`;
            }
        }
    }

    function playChange(lsId, msg, optPort) {
    // record change
    //projects[lsId]?.recordChange(msg)

        // send to local clients
        if (!!optPort) {
            livescratchTabs[lsId]?.forEach((p => { try { if (p != optPort) { p.postMessage(msg); } } catch (e) { console.error(e); } }));
        } else {
            livescratchTabs[lsId]?.forEach(p => { try { p.postMessage(msg); } catch (e) { console.log(e); } });
        }
    }

    //////// INIT SOCKET CONNECTION ///////
    // ['websocket', 'xhr-polling', 'polling', 'htmlfile', 'flashsocket']
    const URLApiUrl = new URL(apiUrl);
    const URLApiDomain = URLApiUrl.origin;
    const URLApiPath = [''].concat(URLApiUrl.pathname.split('/').filter(Boolean)).join('/');
    const socket = io.connect(URLApiDomain, { path: `${URLApiPath}/socket.io/`, transports: ['websocket'], reconnectionDelay: 1000, reconnectionDelayMax: 30000 });
    LIVESCRATCH.socket = socket;
    // const socket = io.connect(apiUrl,{jsonp:false,transports:['websocket']})
    // socket.on("connect_error", () => { socket.io.opts.transports = ["websocket"];});
    console.log('connecting');
    socket.on('connect', async () => {
        console.log('connected with id: ', socket.id);
        ports.forEach(port => port.postMessage({ meta: 'resync' }));
        let lsIds = Object.keys(livescratchTabs);
        if (lsIds.length != 0) { socket.send({ type: 'joinSessions', username: await makeSureUsernameExists(), pk: upk, ids: lsIds, token: currentLsToken }); }
    });
    socket.on('message', (data) => {
        console.log('message', data);
        if (data?.noauth === true) {
            clearRejectedCredentials().catch(error => console.error('Could not clear rejected CoBlocks credentials:', error));
            return;
        }
        if (data.type == 'projectChange') {
            if (data.version) { projects[data.lsId]?.setVersion(data.version - 1); }
            data.msg.version = data.version;
            playChange(data.lsId, data.msg);
        } else if (data.type == 'yourVersion') {
            projects[data.lsId]?.setVersion(data.version);
        }
    });


    uname = (await chrome.storage.local.get(['uname'])).uname; // FIRST DEC
    upk = (await chrome.storage.local.get(['upk'])).upk; // FIRST DEC
    uname = uname ? uname : '*';
    upk = upk ? upk : undefined;


    let lastUnameRefresh = 0;
    let usernameRefreshPromise = null;
    let signedin = false;
    async function refreshUsername(force) {
        if (usernameRefreshPromise) return usernameRefreshPromise;
        if (!force && Date.now() - lastUnameRefresh < 60_000) return uname;
        usernameRefreshPromise = (async () => {
            const res = await fetch('https://scratch.mit.edu/session/', {
                credentials: 'include',
                cache: 'no-store',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });
            if (!res.ok) throw new Error(`Scratch session returned ${res.status}`);
            let json = await res.json();
            lastUnameRefresh = Date.now();
            if (!json.user) {
                if (uname !== '*' || currentLsToken) await logoutLivescratch({ waitForServer: false });
                signedin = false;
                uname = '*';
                upk = undefined;
                currentLsToken = null;
                await chrome.storage.local.remove(['uname', 'upk']);
                return uname;
            }
            if (uname !== '*' && uname.toLowerCase() !== json.user.username.toLowerCase()) {
                await logoutLivescratch({ waitForServer: false });
            }
            signedin = true;
            uname = json.user.username;
            upk = json.user.id;
            await chrome.storage.local.set({ uname, upk });
            await getCurrentLSTokenAfterUsernameRefresh?.();
            return uname;
        })();
        try { return await usernameRefreshPromise; }
        finally { usernameRefreshPromise = null; }
    }
    LIVESCRATCH.refreshUsername = refreshUsername;

    chrome.cookies.onChanged.addListener(changeInfo => {
        const cookie = changeInfo.cookie;
        if (cookie.name === 'scratchsessionsid' && cookie.domain.endsWith('scratch.mit.edu')) {
            refreshUsername(true).catch(error => console.error('Could not refresh Scratch login:', error));
        }
    });

    async function makeSureUsernameExists() {
        if (uname == '*') {
            return refreshUsername();
        } else {
            return uname;
        }
    }
    refreshUsername().catch(console.error);

    // Listen for Project load
    let projectsPageTester = new RegExp('https://scratch.mit.edu/projects/*.');
    chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
        if (changeInfo.url?.startsWith('https://scratch.mit.edu/')) { refreshUsername().catch(console.error); }
        if (changeInfo.url) {
            await makeSureUsernameExists();

            console.log('tab location updated', changeInfo, tab);

            let newUrl = await prepRedirect(tab);
            if (newUrl) {
                console.log('redirecting tab to: ' + newUrl, tab);
                chrome.tabs.update(tab.id, { url: newUrl });
            } else {
                handleNewProject(tab);
            }
        }
    },
    );

    // from chrome runtime documentation
    async function getCurrentTab() {
        let queryOptions = { active: true, lastFocusedWindow: true };
        // `tab` will either be a `tabs.Tab` instance or `undefined`.
        let [tab] = await chrome.tabs.query(queryOptions);
        return tab;
    }

    let userExistsStore = {};
    async function testUserExists(username) {
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return false;
        username = username.toLowerCase();
        const cached = userExistsStore[username];
        if (cached && Date.now() - cached.time < 10 * 60_000) return cached.promise;
        if (Object.keys(userExistsStore).length > 1000) userExistsStore = {};
        const promise = fetch(`${apiUrl}/userExists/${username}`).then(res => res.json());
        userExistsStore[username] = { time: Date.now(), promise };
        try { return await promise; }
        catch (error) { delete userExistsStore[username]; throw error; }
    }



    // Connections to scratch editor instances
    chrome.runtime.onConnectExternal.addListener(function (port) {
        if (!isTrustedScratchSender(port.sender)) {
            port.disconnect();
            return;
        }
        port.name = ++lastPortId;
        ports.push(port);

        let lsId = '';
        // console.assert(port.name === "knockknock");
        port.onMessage.addListener(async function (msg) {
            console.log('isConnected', socket.connected);

            console.log(msg);
            if (msg.meta == 'blockly.event' || msg.meta == 'sprite.proxy' || msg.meta == 'vm.blockListen' || msg.meta == 'vm.shareBlocks' || msg.meta == 'vm.replaceBlocks' || msg.meta == 'vm.updateBitmap' || msg.meta == 'vm.updateSvg' || msg.meta == 'version++') {
                let lsIdd = portIds[port.name];

                msg.user = uname;
                playChange(lsIdd, msg, port);

                // send to websocket
                socket.send({ type: 'projectChange', msg, lsId: lsIdd, token: currentLsToken, username: uname }, (res) => {
                    if (!!res) {
                        port.postMessage({ meta: 'yourVersion', version: res });
                    }
                });
            } else if (msg.meta == 'myId') {
                lsId = msg.id;
                // record websocket id
                if (!(msg.id in livescratchTabs)) {
                    livescratchTabs[msg.id] = [];
                }
                if (port.name in portIds) { }
                else {
                    livescratchTabs[msg.id].push(port);
                    portIds[port.name] = msg.id;
                }

                // create project object
                if (!(msg.id in projects)) {
                    projects[msg.id] = new LivescratchProject();
                }
            } else if (msg.meta == 'joinSession') {
                await makeSureUsernameExists();
                socket.send({ type: 'joinSession', id: portIds[port.name], username: await makeSureUsernameExists(), pk: upk, token: currentLsToken });
            } else if (msg.meta == 'setTitle') {
                playChange(lsId, msg, port);
                // send to websocket
                socket.send({ type: 'setTitle', lsId, msg, token: currentLsToken, username: uname });
            } else if (msg.meta == 'chat') {
                playChange(lsId, msg, port);
                // send to websocket
                socket.send({ type: 'chat', lsId, msg, token: currentLsToken });
            } else if (msg.meta == 'chatnotif') {
                let tab = port.sender.tab;
                let notifs = (await chrome.storage.local.get(['notifs'])).notifs ?? false;
                console.log('notifs', notifs);
                if (notifs) {

                    chrome.notifications.create(null,
                        {
                            type: 'basic',
                            title: 'CoBlocks Chat',
                            contextMessage: `${msg.sender} says in '${msg.project}':`,
                            message: msg.text,
                            // iconUrl:chrome.runtime.getURL('img/CoBlocksIcon.png'),
                            // iconUrl:msg.avatar,
                            // iconUrl:'https://assets.scratch.mit.edu/981e22b1b61cad530d91ea2cfd5ccec7.svg',
                            // iconUrl:'https://upload.wikimedia.org/wikipedia/commons/thumb/0/02/Red_Circle%28small%29.svg/2048px-Red_Circle%28small%29.svg.png'
                            iconUrl: 'img/CoBlocksIcon.png',
                            // isClickable:true,
                        },
                        (notif) => {
                            console.log('😱😱😱😱😱😱😱😱😱 DING DING NOTIFICATION', notif);
                            notificationsDb[notif] = { tab: tab.id, window: tab.windowId };
                            console.error(chrome.runtime.lastError);
                        },
                    );

                    if (!notifListenerAdded) {
                        chrome.notifications.onClicked.addListener(notif => {
                            chrome.tabs.update(notificationsDb[notif]?.tab, { selected: true });
                            chrome.windows.update(notificationsDb[notif]?.window, { focused: true });
                        });
                        notifListenerAdded = true;
                    }
                }
                // if(getCurrentTab()?.id!=tab?.id) {
                // }

            } else {
                msg.lsId = lsId ?? msg.lsId;
                msg.token = currentLsToken;
                socket.send(msg);
            }

        });
        port.onDisconnect.addListener((p) => {
            console.log('port disconnected', p);
            ports.splice(ports.indexOf(p), 1);
            let livescratchId = portIds[p.name];
            let list = livescratchTabs[livescratchId];
            livescratchTabs[livescratchId].splice(list.indexOf(p), 1);
            delete portIds[p.name];
            setTimeout(() => {
                if (livescratchTabs[livescratchId].length == 0) { socket.send({ type: 'leaveSession', id: livescratchId }); }
                if (ports.length == 0) { socket.disconnect(); } // Todo: handle disconnecting and reconnecting backend socket
            }, 5000); // leave socket stuff if page doesnt reconnect in 5 seconds
        });
    });
    var notificationsDb = {};
    var notifListenerAdded = false;

    // Proxy project update messages
    chrome.runtime.onMessageExternal.addListener(
        function (request, sender, sendResponse) {
            if (!isTrustedScratchSender(sender)) return false;
            (async () => {
                console.log('external message:', request.meta);
                if (request.meta == 'getLsId') {
                    if (!request.scratchId || request.scratchId == '.') { sendResponse(''); return; }
                    try {
                        const response = await authenticatedFetch(`${apiUrl}/lsId/${request.scratchId}/${uname}`, { headers: { authorization: currentLsToken } });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const serverId = (await response.text()).replaceAll('"', '');
                        if (serverId && serverId !== 'null') {
                            await recoveryPut('links', { key: recoveryKey(request.scratchId), identity: recoveryIdentity(), scratchId: String(request.scratchId), lsId: String(serverId), savedAt: Date.now() })
                                .catch(error => console.error('Could not cache the CoBlocks project link:', error));
                            sendResponse(serverId);
                            return;
                        }
                    } catch (error) { console.warn('Could not load CoBlocks project link from the server:', error); }
                    sendResponse((await getLocalProjectLink(request.scratchId).catch(() => null))?.lsId || '');
                    // } else if(request.meta =='getInpoint') {
                    //   sendResponse(await (await fetch(`${apiUrl}/projectInpoint/${request.lsId}`)).json())
                } else if (request.meta == 'getJson') {
                    try {
                        const response = await authenticatedFetch(`${apiUrl}/projectJSON/${request.lsId}?username=${uname}`, { headers: { authorization: currentLsToken } });
                        const data = await response.json().catch(() => null);
                        if (data?.noauth) { sendResponse({ err: 'Your CoBlocks login expired.' }); return; }
                        if (!response.ok || !data || !isValidProjectJson(data.json)) throw new Error(`Invalid server project response (${response.status})`);
                        await saveLocalProjectSnapshot(request.lsId, request.scratchId, data.json, data.version)
                            .catch(error => console.error('Could not cache the server project snapshot:', error));
                        sendResponse(data);
                    } catch (error) {
                        console.warn('Using local CoBlocks project recovery snapshot:', error);
                        const local = await getLocalProjectSnapshot(request.lsId).catch(() => null);
                        sendResponse(local && isValidProjectJson(local.json)
                            ? { json: local.json, version: local.version, recoveredLocally: true, savedAt: local.savedAt }
                            : { err: 'The project is unavailable and no valid local recovery snapshot exists.' });
                    }
                } else if (request.meta == 'getChanges') {
                    sendResponse(await (await authenticatedFetch(`${apiUrl}/changesSince/${request.lsId}/${request.version}`, { headers: { authorization: currentLsToken, uname } })).json());
                } else if (request.meta == 'getUsername') {
                    sendResponse(uname);
                } else if (request.meta == 'getUsernamePlus') {
                    console.log('sending response');
                    console.log({ uname, signedin, currentLsToken, apiUrl});
                    sendResponse({ uname, signedin, currentLsToken, apiUrl});
                } else if (request.meta == 'callback') {
                    tabCallbacks[sender.tab.id] = sendResponse;
                } else if (request.meta == 'projectSaved') {
                    // {meta:'projectSaved',lsId,scratchId,version:lsVersion}
                    authenticatedFetch(`${apiUrl}/projectSaved/${request.scratchId}/${request.version}`, { method: 'POST', headers: { authorization: currentLsToken } });
                } else if (request.meta == 'projectSavedJSON') {
                    await saveLocalProjectSnapshot(request.lsId, request.scratchId, request.json, request.version).catch(error => console.error('Could not save local project recovery snapshot:', error));
                    authenticatedFetch(`${apiUrl}/projectSavedJSON/${request.lsId}/${request.version}`, { method: 'POST', body: request.json, headers: { 'Content-Type': 'application/json', authorization: currentLsToken, uname } }).catch(error => console.error('Could not save project to the CoBlocks server:', error));
                } else if (request.meta == 'cacheProjectLocally') {
                    sendResponse({ ok: await saveLocalProjectSnapshot(request.lsId, request.scratchId, request.json, request.version).catch(error => { console.error('Could not update local project recovery snapshot:', error); return false; }) });
                } else if (request.meta == 'myStuff') {
                    sendResponse(await (await authenticatedFetch(`${apiUrl}/userProjectsScratch/${await makeSureUsernameExists()}`, { headers: { authorization: currentLsToken } })).json());
                } else if (request.meta == 'create') {
                    const result = await (await authenticatedFetch(`${apiUrl}/newProject/${request.scratchId}/${await refreshUsername()}?title=${encodeURIComponent(request.title)}`,
                        {
                            method: 'POST',
                            body: request.json,
                            headers: { 'Content-Type': 'application/json', authorization: currentLsToken },
                        }).then(res => res.json()).catch(e => ({ err: e.toString() })));
                    if (result?.id) await saveLocalProjectSnapshot(result.id, request.scratchId, request.json, 0).catch(error => console.error('Could not create local project recovery snapshot:', error));
                    sendResponse(result);
                } else if (request.meta == 'shareWith') {
                    const response = await authenticatedFetch(`${apiUrl}/share/${request.id}/${request.username}/${uname}?pk=${request.pk}`, {
                        method: 'PUT',
                        headers: { authorization: currentLsToken },
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse({ ok: response.ok && !!data.success, status: response.status, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : null) });
                } else if (request.meta == 'unshareWith') {
                    const response = await authenticatedFetch(`${apiUrl}/unshare/${request.id}/${request.user}`, {
                        method: 'PUT',
                        headers: { authorization: currentLsToken, uname },
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse({ ok: response.ok && !!data.success, status: response.status, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : null) });
                } else if (request.meta == 'getShared') {
                    const response = await authenticatedFetch(`${apiUrl}/share/${request.id}`, { headers: { authorization: currentLsToken, uname } });
                    const data = await response.json();
                    sendResponse(response.ok && !data.noauth ? data : { error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not load collaborators.') });
                } else if (request.meta == 'getBackpack') {
                    try {
                        const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}`, { headers: { authorization: currentLsToken, uname } });
                        const data = await response.json().catch(() => ({}));
                        sendResponse(response.ok ? { ok: true, items: data } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not load the shared backpack.') });
                    } catch (error) {
                        console.error('Could not load the shared backpack:', error);
                        sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                    }
                } else if (request.meta == 'addBackpackItem') {
                    try {
                        const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}`, {
                            method: 'POST',
                            headers: { authorization: currentLsToken, uname, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: request.name, blocks: request.blocks, thumbnail: request.thumbnail }),
                        });
                        const data = await response.json().catch(() => ({}));
                        sendResponse(response.ok ? { ok: true, item: data } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not share that script.') });
                    } catch (error) {
                        console.error('Could not add to the shared backpack:', error);
                        sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                    }
                } else if (request.meta == 'deleteBackpackItem') {
                    try {
                        const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}/${encodeURIComponent(request.itemId)}`, {
                            method: 'DELETE',
                            headers: { authorization: currentLsToken, uname },
                        });
                        const data = await response.json().catch(() => ({}));
                        sendResponse(response.ok ? { ok: true } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not remove that script.') });
                    } catch (error) {
                        console.error('Could not remove from the shared backpack:', error);
                        sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                    }
                } else if (request.meta == 'getTitle') {
                    sendResponse((await (await authenticatedFetch(`${apiUrl}/projectTitle/${request.lsId}`, { headers: { authorization: currentLsToken, uname } })).json()).title);
                } else if (request.meta == 'leaveScratchId') {
                    authenticatedFetch(`${apiUrl}/leaveScratchId/${request.scratchId}/${await refreshUsername()}`, {
                        method: 'PUT',
                        headers: { authorization: currentLsToken },
                    });
                } else if (request.meta == 'leaveLSId') {
                    authenticatedFetch(`${apiUrl}/leaveLSId/${request.lsId}/${await refreshUsername()}`, {
                        method: 'PUT',
                        headers: { authorization: currentLsToken },
                    });
                } else if (request.meta == 'getActive') {
                    sendResponse(await (await authenticatedFetch(`${apiUrl}/active/${request.id}`, { headers: { authorization: currentLsToken, uname } })).json());
                } else if (request.meta == 'getUrl') {
                    sendResponse(await chrome.runtime.getURL(request.for));
                } else if (request.meta == 'isPingEnabled') {
                    sendResponse((await chrome.storage.local.get(['ping'])).ping);
                } else if (request.meta == 'userExists') {
                    sendResponse(await testUserExists(request.username));
                }  else if (request.meta == 'badges?') {
                    sendResponse({badges:(await chrome.storage.local.get(['badges'])).badges});
                } 
            })();
            return true;
        });

    function isTrustedScratchSender(sender) {
        const source = sender?.url || sender?.tab?.url || sender?.origin;
        try {
            return new URL(source).origin === 'https://scratch.mit.edu';
        } catch {
            return false;
        }
    }


    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (request.meta == 'getUsername') {
            sendResponse(uname);
        } else if (request.meta == 'getUsernamePlus') {
            refreshUsername(request.forceRefresh === true).catch(console.error).finally(() => {
                sendResponse({ uname, signedin, currentLsToken, apiUrl });
            });
            return true;
        }
    });
}
