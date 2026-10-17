// Socket.IO registers a browser-only beforeunload handler. Ignore it in the
// extension service worker while preserving all other event listeners.
self.addEventListener = (function (original) {
    return function (type, listener, options) {
        if (type === 'beforeunload') {
            console.warn('Ignoring \'beforeunload\' listener in service worker context.');
            return;
        }
        return original.call(self, type, listener, options);
    };
})(self.addEventListener);

if (typeof importScripts === 'function') importScripts('background/socket.io.js', 'background/auth.js', 'background/updates.js');

const API_PREFIX = '/apiv2';
const RECOVERY_DB_NAME = 'LiveScratchRecovery'; // Keep the legacy name so existing recovery data remains available.
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
    const identity = recoveryIdentity();
    if (!identity || identity === '*') return false;
    const db = await openRecoveryDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(value);
        transaction.oncomplete = () => { db.close(); resolve(true); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
}

async function recoveryGet(storeName, key) {
    const identity = recoveryIdentity();
    if (!identity || identity === '*') return null;
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

async function getApiUrl() {
    const settings = await chrome.storage.local.get(['custom-server', 'server-url']);
    const serverUrl = settings['custom-server']
        ? settings['server-url']
        : 'https://livescratchapi.waakul.com';
    return addApiPrefix(serverUrl || 'https://livescratchapi.waakul.com');
}

function getCollaborationInvite(url) {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.origin !== 'https://scratch.mit.edu') return null;
        const projectId = parsedUrl.searchParams.get('coblocksProject');
        const token = parsedUrl.searchParams.get('coblocksInvite');
        if (!/^\d+$/.test(projectId || '') || !token) return null;
        return { projectId, token };
    } catch {
        return null;
    }
}

// Register this listener synchronously. Scratch may replace /create?... before
// the rest of the service worker has finished loading.
const queuedInviteNavigations = new Map();
let processInviteNavigation = null;
function captureInviteNavigation(tabId, url, tab) {
    const invite = getCollaborationInvite(url);
    if (!invite) return;
    const navigation = { tabId, tab, ...invite };
    if (processInviteNavigation) {
        processInviteNavigation(navigation).catch(error => {
            console.error('Could not accept the collaboration invite:', error);
        });
    } else {
        queuedInviteNavigations.set(tabId, navigation);
    }
}
chrome.tabs.onCreated.addListener(tab => {
    captureInviteNavigation(tab.id, tab.pendingUrl || tab.url, tab);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    captureInviteNavigation(tabId, changeInfo.url, tab);
});
chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return;
    captureInviteNavigation(details.tabId, details.url, { id: details.tabId, url: details.url });
}, { url: [{ hostEquals: 'scratch.mit.edu' }] });

let apiUrl;

function handleApiUrlRequest(request, sender, sendResponse) {
    if (request.meta !== 'getAPI-URL') return false;
    if (!sender.url?.startsWith('https://scratch.mit.edu/')) return false;
    getApiUrl().then(url => sendResponse({ apiURL: url })).catch(error => {
        sendResponse({ error: error.message });
    });
    return true;
}
chrome.runtime.onMessageExternal.addListener(handleApiUrlRequest);
chrome.runtime.onMessage.addListener(handleApiUrlRequest);

const backgroundReady = getApiUrl()
    .catch(error => {
        console.error('Could not load the configured API URL:', error);
        return addApiPrefix('https://livescratchapi.waakul.com');
    })
    .then(async url => {
        apiUrl = url;
        await backgroundScript();
    });
backgroundReady.then(() => resumeScratchAuth()).catch(error => {
    console.error('Could not initialize the CoBlocks background worker:', error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.meta === 'scratchBridgeReady' && sender.url?.startsWith('https://scratch.mit.edu/')) {
        backgroundReady.then(() => sendResponse({ ready: true })).catch(error => sendResponse({ error: error.message }));
        return true;
    }
    if (sender.url?.startsWith('https://scratch.mit.edu/')) return false;
    if (message.meta === 'getAPI-URL') {
        sendResponse({ apiURL: apiUrl });
        return false;
    }
    return false;
});

let uname = '*';
let upk;

chrome.runtime.onInstalled.addListener(async (details) => {
    const { apiUpdateReload } = await chrome.storage.local.get('apiUpdateReload');
    if (apiUpdateReload) {
        await chrome.storage.local.set({ apiUpdateReload: false });
        if (details.reason !== chrome.runtime.OnInstalledReason.UPDATE
            || details.previousVersion === chrome.runtime.getManifest().version) return;
    }

    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        chrome.tabs.create({ url: 'https://ko-fi.com/waakul' });
        chrome.tabs.create({ url: 'https://livescratch.waakul.com' });
    } else if (details.reason === chrome.runtime.OnInstalledReason.UPDATE
        && details.previousVersion !== chrome.runtime.getManifest().version) {
        const version = chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version;
        await chrome.storage.local.set({ pendingExtensionUpdate: { version, previousVersion: details.previousVersion } });
        await chrome.storage.local.remove('extensionUpdateClaim');
    }
});


const COBLOCKS = {};
async function backgroundScript() {
    const projectPorts = {};
    const portProjects = {};

    let lastPortId = 0;
    const ports = [];

    COBLOCKS.onAuthenticated = async () => {
        ports.forEach(port => { try { port.postMessage({ meta: 'resync' }); } catch (error) { console.error(error); } });
        const ids = Object.keys(projectPorts);
        if (socket.connected && ids.length) socket.send({ type: 'joinSessions', username: uname, pk: upk, ids, token: currentCoBlocksToken });
    };

    COBLOCKS.onLoggedOut = () => {
        Object.keys(projectPorts).forEach(id => {
            if (socket.connected) socket.send({ type: 'leaveSession', id });
        });
    };

    const newProjects = {}; // tabId (or 'newtab') -> lsId
    const tabCallbacks = {}; // tabId -> callback function
    const pendingTabInitializations = {};
    const inviteAcceptances = new Map();

    function initializeLinkedTab(tabId, lsId) {
        const callback = tabCallbacks[tabId];
        if (callback) {
            delete tabCallbacks[tabId];
            callback({ meta: 'initCoBlocks', lsId });
        } else {
            pendingTabInitializations[tabId] = lsId;
        }
    }

    function getProjectId(url) {
        if (projectsPageTester.test(url)) {
            const id = new URL(url).pathname.split('/')[2];
            // Ignore URLs that are not Scratch project pages.
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
        const id = getProjectId(tab.url);
        if (id && tab.id in newProjects) {
            const lsId = newProjects[tab.id];
            const response = await authenticatedFetch(`${apiUrl}/linkScratch/${id}/${lsId}/${uname}`, {
                method: 'PUT',
                headers: { authorization: currentCoBlocksToken },
            }); // link scratch project with api
            if (response.ok) {
                delete newProjects[tab.id];
                initializeLinkedTab(tab.id, lsId);
            }
        }
    }

    async function acceptInvite(projectId, token, tabId, initialUrl) {
        const pending = inviteAcceptances.get(tabId);
        if (pending?.projectId === projectId && pending.token === token) return pending.promise;

        const promise = (async () => {
            const username = await refreshUsername(true);
            if (!username || username === '*' || !currentCoBlocksToken) {
                return { ok: false, status: 401, error: 'Sign in to CoBlocks before accepting this invite.' };
            }

            const response = await authenticatedFetch(`${apiUrl}/invite/${projectId}/accept`, {
                method: 'POST',
                headers: { authorization: currentCoBlocksToken, uname: username, 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                return {
                    ok: false,
                    status: response.status,
                    error: data.err || (data.noauth ? 'Sign in to CoBlocks before accepting this invite.' : 'Could not accept the invite.'),
                };
            }

            if (!tabId) return { ok: true, ...data };
            if (data.scratchId) {
                await chrome.tabs.update(tabId, { url: `https://scratch.mit.edu/projects/${data.scratchId}/editor` });
                return { ok: true, ...data };
            }

            let currentTab = null;
            try {
                currentTab = await chrome.tabs.get(tabId);
            } catch {
                // The invite was accepted even if its tab has since closed.
            }
            const currentScratchId = getProjectId(currentTab?.url || initialUrl);
            if (!currentScratchId) {
                newProjects[tabId] = data.projectId;
                return { ok: true, ...data };
            }

            const linkResponse = await authenticatedFetch(`${apiUrl}/linkScratch/${currentScratchId}/${data.projectId}/${username}`, {
                method: 'PUT',
                headers: { authorization: currentCoBlocksToken },
            });
            if (!linkResponse.ok) {
                const linkError = await linkResponse.json().catch(() => ({}));
                return { ok: false, status: linkResponse.status, error: linkError.err || 'Could not link the new Scratch project.' };
            }
            initializeLinkedTab(tabId, data.projectId);
            return { ok: true, ...data, scratchId: currentScratchId };
        })();

        inviteAcceptances.set(tabId, { projectId, token, promise });
        try {
            return await promise;
        } finally {
            if (inviteAcceptances.get(tabId)?.promise === promise) inviteAcceptances.delete(tabId);
        }
    }

    const newProjectPage = 'https://scratch.mit.edu/create';
    async function prepRedirect(tab) {
        if (uname === '*') { return false; }
        const id = getProjectId(tab.url);


        // Ignore URLs that are not Scratch project pages.
        if (!id) { return false; }
        const info = await (await authenticatedFetch(apiUrl + `/userRedirect/${id}/${uname}`, { headers: { authorization: currentCoBlocksToken } })).json();
        // dont redirect if scratch id is not associated with ls project
        if (info.goto === 'none') { return false; }
        // dont redirect if already on project
        if (String(info.goto) === String(id)) return false;

        if (info.goto === 'new') {
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

    function playChange(lsId, msg, sourcePort) {
        if (sourcePort) {
            projectPorts[lsId]?.forEach(port => {
                try {
                    if (port !== sourcePort) port.postMessage(msg);
                } catch (error) {
                    console.error('Could not forward a local project change:', error);
                }
            });
        } else {
            projectPorts[lsId]?.forEach(port => {
                try {
                    port.postMessage(msg);
                } catch (error) {
                    console.error('Could not forward a project change:', error);
                }
            });
        }
    }

    //////// INIT SOCKET CONNECTION ///////
    // ['websocket', 'xhr-polling', 'polling', 'htmlfile', 'flashsocket']
    const URLApiUrl = new URL(apiUrl);
    const socketProtocol = URLApiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketDomain = `${socketProtocol}//${URLApiUrl.host}`;
    const URLApiPath = [''].concat(URLApiUrl.pathname.split('/').filter(Boolean)).join('/');
    const socket = io.connect(socketDomain, {
        path: `${URLApiPath}/socket.io/`,
        transports: ['websocket'],
        secure: socketProtocol === 'wss:',
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
    });
    COBLOCKS.socket = socket;
    // const socket = io.connect(apiUrl,{jsonp:false,transports:['websocket']})
    // socket.on("connect_error", () => { socket.io.opts.transports = ["websocket"];});
    socket.on('connect', async () => {
        ports.forEach(port => port.postMessage({ meta: 'resync' }));
        const lsIds = Object.keys(projectPorts);
        if (lsIds.length !== 0) { socket.send({ type: 'joinSessions', username: await makeSureUsernameExists(), pk: upk, ids: lsIds, token: currentCoBlocksToken }); }
    });
    socket.on('message', (data) => {
        if (data?.noauth === true) {
            clearRejectedCredentials().catch(error => console.error('Could not clear rejected CoBlocks credentials:', error));
            return;
        }
        if (data.type === 'projectChange') {
            data.msg.version = data.version;
            playChange(data.lsId, data.msg);
        }
    });


    uname = (await chrome.storage.local.get(['uname'])).uname; // FIRST DEC
    upk = (await chrome.storage.local.get(['upk'])).upk; // FIRST DEC
    uname = uname ? uname : '*';
    upk = upk ? upk : undefined;


    let lastUnameRefresh = 0;
    let usernameRefreshPromise = null;
    let signedin = false;

    async function fetchScratchSessionFromOpenTab() {
        let tabs;
        try {
            tabs = await chrome.tabs.query({ url: 'https://scratch.mit.edu/*' });
        } catch (error) {
            console.warn('Could not inspect open Scratch tabs:', error);
            return null;
        }

        let timeout;
        try {
            const requests = tabs.filter(tab => tab.id).map(async tab => {
                const result = await chrome.tabs.sendMessage(tab.id, { meta: 'getScratchSession' });
                if (!result?.ok || !result.session?.user) throw new Error('No Scratch session in this tab.');
                return result.session;
            });
            return await Promise.race([
                Promise.any(requests).catch(() => null),
                new Promise(resolve => { timeout = setTimeout(() => resolve(null), 8000); }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    }

    async function getScratchSession() {
        try {
            const response = await fetch('https://scratch.mit.edu/session/', {
                credentials: 'include',
                cache: 'no-store',
                signal: AbortSignal.timeout(8000),
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (response.ok) {
                const session = await response.json();
                if (session?.user) return session;
            }
        } catch (error) {
            console.warn('Direct Scratch session check failed:', error);
        }

        return fetchScratchSessionFromOpenTab();
    }

    async function hasScratchSessionCookie() {
        try {
            return Boolean(await chrome.cookies.get({
                url: 'https://scratch.mit.edu/',
                name: 'scratchsessionsid',
            }));
        } catch (error) {
            console.warn('Could not inspect the Scratch session cookie:', error);
            return false;
        }
    }

    async function refreshUsername(force) {
        if (usernameRefreshPromise) return usernameRefreshPromise;
        if (!force && Date.now() - lastUnameRefresh < 60_000) return uname;
        usernameRefreshPromise = (async () => {
            const json = await getScratchSession();
            lastUnameRefresh = Date.now();
            if (!json?.user) {
                // A service worker can be denied Scratch cookies even while the
                // user is signed in. Keep the known identity in that ambiguous
                // state; only clear credentials when the cookie is truly gone.
                if (await hasScratchSessionCookie()) {
                    signedin = uname !== '*';
                    return uname;
                }
                if (uname !== '*' || currentCoBlocksToken) {
                    await clearRejectedCredentials(
                        'Sign in to Scratch and then sign in to CoBlocks again.',
                        { clearAllTokens: true },
                    );
                }
                signedin = false;
                uname = '*';
                upk = undefined;
                currentCoBlocksToken = null;
                await chrome.storage.local.remove(['uname', 'upk']);
                return uname;
            }
            if (uname !== '*' && uname.toLowerCase() !== json.user.username.toLowerCase()) {
                await clearRejectedCredentials(
                    'Your Scratch account changed. Sign in to CoBlocks again with the current Scratch account.',
                    { clearAllTokens: true },
                );
            }
            signedin = true;
            uname = json.user.username;
            upk = json.user.id;
            await chrome.storage.local.set({ uname, upk });
            await getCurrentCoBlocksTokenAfterUsernameRefresh?.();
            return uname;
        })();
        try { return await usernameRefreshPromise; } finally { usernameRefreshPromise = null; }
    }
    COBLOCKS.refreshUsername = refreshUsername;
    COBLOCKS.acceptAuthenticatedUsername = async username => {
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return false;
        if (uname !== '*' && uname.toLowerCase() !== username.toLowerCase()) return false;
        uname = username;
        signedin = true;
        await chrome.storage.local.set({ uname });
        return true;
    };

    chrome.cookies.onChanged.addListener(changeInfo => {
        const cookie = changeInfo.cookie;
        if (cookie.name === 'scratchsessionsid' && cookie.domain.endsWith('scratch.mit.edu')) {
            refreshUsername(true).catch(error => console.error('Could not refresh Scratch login:', error));
        }
    });

    async function makeSureUsernameExists() {
        if (uname === '*') {
            return refreshUsername();
        } else {
            return uname;
        }
    }
    refreshUsername().catch(console.error);

    // Listen for Project load
    const projectsPageTester = /^https:\/\/scratch\.mit\.edu\/projects\/\d+/;
    processInviteNavigation = async navigation => {
        const result = await acceptInvite(
            navigation.projectId,
            navigation.token,
            navigation.tabId,
            navigation.tab?.url,
        );
        if (!result.ok) console.warn('Could not accept the collaboration invite:', result.error);
    };
    const savedInviteNavigations = [...queuedInviteNavigations.values()];
    queuedInviteNavigations.clear();
    savedInviteNavigations.forEach(navigation => {
        processInviteNavigation(navigation).catch(error => {
            console.error('Could not accept the collaboration invite:', error);
        });
    });

    chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
        if (changeInfo.url?.startsWith('https://scratch.mit.edu/')) { refreshUsername().catch(console.error); }
        if (changeInfo.url) {
            await makeSureUsernameExists();


            const newUrl = await prepRedirect(tab);
            if (newUrl) {
                chrome.tabs.update(tab.id, { url: newUrl });
            } else {
                handleNewProject(tab);
            }
        }
    },
    );

    let userExistsStore = {};
    async function testUserExists(username) {
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return false;
        username = username.toLowerCase();
        const cached = userExistsStore[username];
        if (cached && Date.now() - cached.time < 10 * 60_000) return cached.promise;
        if (Object.keys(userExistsStore).length > 1000) userExistsStore = {};
        const promise = fetch(`${apiUrl}/userExists/${username}`).then(res => res.json());
        userExistsStore[username] = { time: Date.now(), promise };
        try { return await promise; } catch (error) { delete userExistsStore[username]; throw error; }
    }



    // Connections to scratch editor instances
    function connectScratchEditor(port) {
        if (!isTrustedScratchSender(port.sender)) {
            port.disconnect();
            return;
        }
        if (!socket.connected) socket.connect();
        const portId = ++lastPortId;
        ports.push(port);

        let lsId = '';
        // console.assert(port.name === "knockknock");
        port.onMessage.addListener(async function (msg) {

            if (msg.meta === 'blockly.event' || msg.meta === 'sprite.proxy' || msg.meta === 'vm.blockListen' || msg.meta === 'vm.shareBlocks' || msg.meta === 'vm.replaceBlocks' || msg.meta === 'vm.updateBitmap' || msg.meta === 'vm.updateSvg' || msg.meta === 'version++') {
                const lsIdd = portProjects[portId];

                msg.user = uname;
                playChange(lsIdd, msg, port);

                // send to websocket
                socket.send({ type: 'projectChange', msg, lsId: lsIdd, token: currentCoBlocksToken, username: uname }, (res) => {
                    if (!!res) {
                        port.postMessage({ meta: 'yourVersion', version: res });
                    }
                });
            } else if (msg.meta === 'myId') {
                lsId = msg.id;
                // record websocket id
                if (!(msg.id in projectPorts)) {
                    projectPorts[msg.id] = [];
                }
                if (!(portId in portProjects)) {
                    projectPorts[msg.id].push(port);
                    portProjects[portId] = msg.id;
                }
            } else if (msg.meta === 'joinSession') {
                await makeSureUsernameExists();
                socket.send({ type: 'joinSession', id: portProjects[portId], username: await makeSureUsernameExists(), pk: upk, token: currentCoBlocksToken });
            } else if (msg.meta === 'setTitle') {
                playChange(lsId, msg, port);
                // send to websocket
                socket.send({ type: 'setTitle', lsId, msg, token: currentCoBlocksToken, username: uname });
            } else if (msg.meta === 'chat') {
                playChange(lsId, msg, port);
                // send to websocket
                socket.send({ type: 'chat', lsId, msg, token: currentCoBlocksToken });
            } else if (msg.meta === 'chatnotif') {
                const tab = port.sender.tab;
                const notifs = (await chrome.storage.local.get(['notifs'])).notifs ?? false;
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
                            notificationsDb[notif] = { tab: tab.id, window: tab.windowId, action: 'chat' };
                            if (chrome.runtime.lastError) {
                                console.error('Could not create a CoBlocks notification:', chrome.runtime.lastError);
                            }
                        },
                    );

                    if (!notifListenerAdded) {
                        chrome.notifications.onClicked.addListener(notif => {
                            const notification = notificationsDb[notif];
                            if (!notification) return;
                            chrome.tabs.update(notification.tab, { active: true });
                            chrome.windows.update(notification.window, { focused: true });
                            if (notification.action === 'chat') {
                                ports.find(openPort => openPort.sender.tab?.id === notification.tab)?.postMessage({ meta: 'openChat' });
                            }
                            delete notificationsDb[notif];
                        });
                        notifListenerAdded = true;
                    }
                }
                // if(getCurrentTab()?.id!==tab?.id) {
                // }

            } else {
                msg.lsId = lsId ?? msg.lsId;
                msg.token = currentCoBlocksToken;
                msg.username = uname;
                socket.send(msg);
            }

        });
        port.onDisconnect.addListener(disconnectedPort => {
            const portIndex = ports.indexOf(disconnectedPort);
            if (portIndex !== -1) ports.splice(portIndex, 1);

            const projectId = portProjects[portId];
            const projectPortList = projectPorts[projectId];
            const projectPortIndex = projectPortList?.indexOf(disconnectedPort) ?? -1;
            if (projectPortIndex !== -1) projectPortList.splice(projectPortIndex, 1);
            delete portProjects[portId];
            setTimeout(() => {
                if (projectPorts[projectId]?.length === 0) {
                    socket.send({ type: 'leaveSession', id: projectId });
                    delete projectPorts[projectId];
                }
                if (ports.length === 0) socket.disconnect();
            }, 5000);
        });
    }
    chrome.runtime.onConnectExternal.addListener(connectScratchEditor);
    chrome.runtime.onConnect.addListener(connectScratchEditor);
    const notificationsDb = {};
    let notifListenerAdded = false;

    // Proxy project update messages
    function handleScratchMessage(request, sender, sendResponse) {
        if (!isTrustedScratchSender(sender)) return false;
        if (request.meta === 'getAPI-URL') return false;
        (async () => {
            if (request.meta === 'getLsId') {
                if (!request.scratchId || request.scratchId === '.') { sendResponse(''); return; }
                try {
                    const response = await authenticatedFetch(`${apiUrl}/lsId/${request.scratchId}/${uname}`, { headers: { authorization: currentCoBlocksToken } });
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
                // } else if(request.meta ==='getInpoint') {
                //   sendResponse(await (await fetch(`${apiUrl}/projectInpoint/${request.lsId}`)).json())
            } else if (request.meta === 'getJson') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/projectJSON/${request.lsId}?username=${uname}`, { headers: { authorization: currentCoBlocksToken } });
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
            } else if (request.meta === 'getChanges') {
                sendResponse(await (await authenticatedFetch(`${apiUrl}/changesSince/${request.lsId}/${request.version}`, { headers: { authorization: currentCoBlocksToken, uname } })).json());
            } else if (request.meta === 'getUsername') {
                sendResponse(uname);
            } else if (request.meta === 'getUsernamePlus') {
                await refreshUsername();
                sendResponse({
                    uname,
                    signedin,
                    currentCoBlocksToken,
                    currentLsToken: currentCoBlocksToken,
                    apiUrl,
                });
            } else if (request.meta === 'callback') {
                tabCallbacks[sender.tab.id] = sendResponse;
                if (pendingTabInitializations[sender.tab.id]) {
                    sendResponse({ meta: 'initCoBlocks', lsId: pendingTabInitializations[sender.tab.id] });
                    delete pendingTabInitializations[sender.tab.id];
                    delete tabCallbacks[sender.tab.id];
                }
            } else if (request.meta === 'projectSaved') {
                // {meta:'projectSaved',lsId,scratchId,version:lsVersion}
                authenticatedFetch(`${apiUrl}/projectSaved/${request.scratchId}/${request.version}`, { method: 'POST', headers: { authorization: currentCoBlocksToken } });
            } else if (request.meta === 'projectSavedJSON') {
                await saveLocalProjectSnapshot(request.lsId, request.scratchId, request.json, request.version).catch(error => console.error('Could not save local project recovery snapshot:', error));
                authenticatedFetch(`${apiUrl}/projectSavedJSON/${request.lsId}/${request.version}`, { method: 'POST', body: request.json, headers: { 'Content-Type': 'application/json', authorization: currentCoBlocksToken, uname } }).catch(error => console.error('Could not save project to the CoBlocks server:', error));
            } else if (request.meta === 'cacheProjectLocally') {
                sendResponse({ ok: await saveLocalProjectSnapshot(request.lsId, request.scratchId, request.json, request.version).catch(error => { console.error('Could not update local project recovery snapshot:', error); return false; }) });
            } else if (request.meta === 'myStuff') {
                sendResponse(await (await authenticatedFetch(`${apiUrl}/userProjectsScratch/${await makeSureUsernameExists()}`, { headers: { authorization: currentCoBlocksToken } })).json());
            } else if (request.meta === 'create') {
                const result = await (await authenticatedFetch(`${apiUrl}/newProject/${request.scratchId}/${await refreshUsername()}?title=${encodeURIComponent(request.title)}`,
                    {
                        method: 'POST',
                        body: request.json,
                        headers: { 'Content-Type': 'application/json', authorization: currentCoBlocksToken },
                    }).then(res => res.json()).catch(e => ({ err: e.toString() })));
                if (result?.id) await saveLocalProjectSnapshot(result.id, request.scratchId, request.json, 0).catch(error => console.error('Could not create local project recovery snapshot:', error));
                sendResponse(result);
            } else if (request.meta === 'shareWith') {
                const response = await authenticatedFetch(`${apiUrl}/share/${request.id}/${request.username}/${uname}?pk=${request.pk}`, {
                    method: 'PUT',
                    headers: { authorization: currentCoBlocksToken },
                });
                const data = await response.json().catch(() => ({}));
                sendResponse({ ok: response.ok && !!data.success, status: response.status, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : null) });
            } else if (request.meta === 'unshareWith') {
                const response = await authenticatedFetch(`${apiUrl}/unshare/${request.id}/${request.user}`, {
                    method: 'PUT',
                    headers: { authorization: currentCoBlocksToken, uname },
                });
                const data = await response.json().catch(() => ({}));
                sendResponse({ ok: response.ok && !!data.success, status: response.status, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : null) });
            } else if (request.meta === 'getShared') {
                const response = await authenticatedFetch(`${apiUrl}/share/${request.id}`, { headers: { authorization: currentCoBlocksToken, uname } });
                const data = await response.json();
                sendResponse(response.ok && !data.noauth ? data : { error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not load collaborators.') });
            } else if (request.meta === 'createInvite') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/invite/${request.id}`, {
                        method: 'POST',
                        headers: { authorization: currentCoBlocksToken, uname },
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse(response.ok ? { ok: true, ...data } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not create an invite.') });
                } catch {
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'revokeInvite') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/invite/${request.id}`, {
                        method: 'DELETE',
                        headers: { authorization: currentCoBlocksToken, uname },
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse(response.ok ? { ok: true } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not revoke the invite.') });
                } catch {
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'acceptInvite') {
                try {
                    sendResponse(await acceptInvite(request.id, request.token, sender.tab?.id, sender.tab?.url));
                } catch {
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'getBackpack') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}`, { headers: { authorization: currentCoBlocksToken, uname } });
                    const data = await response.json().catch(() => ({}));
                    sendResponse(response.ok ? { ok: true, items: data } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not load the shared backpack.') });
                } catch (error) {
                    console.error('Could not load the shared backpack:', error);
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'addBackpackItem') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}`, {
                        method: 'POST',
                        headers: { authorization: currentCoBlocksToken, uname, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: request.name, blocks: request.blocks, thumbnail: request.thumbnail }),
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse(response.ok ? { ok: true, item: data } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not share that script.') });
                } catch (error) {
                    console.error('Could not add to the shared backpack:', error);
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'deleteBackpackItem') {
                try {
                    const response = await authenticatedFetch(`${apiUrl}/backpack/${request.id}/${encodeURIComponent(request.itemId)}`, {
                        method: 'DELETE',
                        headers: { authorization: currentCoBlocksToken, uname },
                    });
                    const data = await response.json().catch(() => ({}));
                    sendResponse(response.ok ? { ok: true } : { ok: false, error: data.err || (data.noauth ? 'Your CoBlocks login expired.' : 'Could not remove that script.') });
                } catch (error) {
                    console.error('Could not remove from the shared backpack:', error);
                    sendResponse({ ok: false, error: 'Could not reach the CoBlocks server.' });
                }
            } else if (request.meta === 'getTitle') {
                sendResponse((await (await authenticatedFetch(`${apiUrl}/projectTitle/${request.lsId}`, { headers: { authorization: currentCoBlocksToken, uname } })).json()).title);
            } else if (request.meta === 'leaveScratchId') {
                authenticatedFetch(`${apiUrl}/leaveScratchId/${request.scratchId}/${await refreshUsername()}`, {
                    method: 'PUT',
                    headers: { authorization: currentCoBlocksToken },
                });
            } else if (request.meta === 'leaveLSId') {
                authenticatedFetch(`${apiUrl}/leaveLSId/${request.lsId}/${await refreshUsername()}`, {
                    method: 'PUT',
                    headers: { authorization: currentCoBlocksToken },
                });
            } else if (request.meta === 'getActive') {
                sendResponse(await (await authenticatedFetch(`${apiUrl}/active/${request.id}`, { headers: { authorization: currentCoBlocksToken, uname } })).json());
            } else if (request.meta === 'getUrl') {
                sendResponse(await chrome.runtime.getURL(request.for));
            } else if (request.meta === 'isPingEnabled') {
                sendResponse((await chrome.storage.local.get(['ping'])).ping);
            } else if (request.meta === 'userExists') {
                sendResponse(await testUserExists(request.username));
            } else if (request.meta === 'badges?') {
                sendResponse({ badges: (await chrome.storage.local.get(['badges'])).badges });
            }
        })().catch(error => {
            console.error('CoBlocks editor request failed:', request.meta, error);
            sendResponse({ ok: false, error: error.message || 'Could not complete the CoBlocks request.' });
        });
        return true;
    }
    chrome.runtime.onMessageExternal.addListener(handleScratchMessage);
    chrome.runtime.onMessage.addListener(handleScratchMessage);

    function isTrustedScratchSender(sender) {
        const source = sender?.url || sender?.tab?.url || sender?.origin;
        try {
            return new URL(source).origin === 'https://scratch.mit.edu';
        } catch {
            return false;
        }
    }


    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (isTrustedScratchSender(sender)) return false;
        if (request.meta === 'getUsername') {
            sendResponse(uname);
        } else if (request.meta === 'getUsernamePlus') {
            refreshUsername(request.forceRefresh === true).catch(console.error).finally(() => {
                sendResponse({
                    uname,
                    signedin,
                    currentCoBlocksToken,
                    currentLsToken: currentCoBlocksToken,
                    apiUrl,
                });
            });
            return true;
        }
    });
}
