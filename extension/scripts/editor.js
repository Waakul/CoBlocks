// get exId
const editorScriptElement = document.querySelector('.livescratch-ext');
const exId = editorScriptElement.dataset.exId;
let apiUrl = '';
const logoUrl = editorScriptElement.dataset.logoUrl || new URL('../img/CoBlocksIcon.png', editorScriptElement.src).href;
const pingUrl = new URL('../sounds/ping.mp3', editorScriptElement.src).href;
const pendingInviteKey = 'coblocksPendingInvite';
const initialUrl = new URL(location.href);
const initialInvite = {
    projectId: initialUrl.searchParams.get('coblocksProject'),
    token: initialUrl.searchParams.get('coblocksInvite'),
};
if (initialInvite.projectId && initialInvite.token) {
    sessionStorage.setItem(pendingInviteKey, JSON.stringify(initialInvite));
    initialUrl.searchParams.delete('coblocksProject');
    initialUrl.searchParams.delete('coblocksInvite');
    history.replaceState(null, '', initialUrl);
}
window.coBlocksRuntime.sendMessage(exId, { meta: 'getAPI-URL' }, function(response) {
    if (window.coBlocksRuntime.lastError) return;
    if (response?.apiURL) apiUrl = response.apiURL;
});

window.coBlocksRuntime.sendMessage(exId, { meta: 'getUsernamePlus' }, (userData) => {
    if (window.coBlocksRuntime.lastError) return;
    if (userData?.apiUrl) apiUrl = userData.apiUrl;
});

//////////// TRAP UTILS ///////////

function sleep(millis) {
    return new Promise(res => setTimeout(res, millis));
}
let revertJSON = null;
const queryList = [];
let bl_projectId = null;
store = null;
let playAfterDragStop = [];
const finishedSavingCB = [];
function mutationCallback() {
    if (typeof BL_UTILS === 'object') {
        if (!BL_UTILS.isDragging() && playAfterDragStop.length > 0) {
            playAfterDragStop.forEach(msg => { collaborationListener(msg); });
            playAfterDragStop = [];
        }
    }
    if (bl_projectId && String(store?.getState().preview.projectInfo.id) !== String(bl_projectId)) location.reload();
    bl_projectId = store?.getState().preview.projectInfo.id;
    const toDelete = [];
    queryList.forEach(query => {
        const elem = document.querySelector(query.query);
        if (elem && !elem.lsSeen) {
            if (query.once) { toDelete.push(query); } else { elem.lsSeen = true; }
            query.callback(elem);
        }
    });
    toDelete.forEach(query => { queryList.splice(queryList.indexOf(query), 1); });
}
const observer = new MutationObserver(mutationCallback);
observer.observe(document.documentElement, { subtree: true, childList: true });
function getObj(query) {
    const obj = document.querySelector(query);
    if (obj) { return new Promise(res => { res(obj); }); }
    return new Promise(res => {
        queryList.push({ query, callback: res, once: true });
    });
}
function listenForObj(query, callback) {
    const obj = document.querySelector(query);
    if (obj) { obj.lsSeen = true; callback(obj); }
    queryList.push({ query, callback, once: false });
}

function waitFor(lambda) {
    return new Promise(async res => {
        let output;
        while (!(output = lambda())) {
            await sleep(100);
        }
        res(output);
    });
}



///.......... BG SCRIPT CONNECTION SETUP ..........//

// Connect To Background Script
// var port = window.coBlocksRuntime.connect(exId);
let port;
let isConnected = false;

function liveMessage(message, res) {
    if (coblocksDisabled) { return; }
    reconnectIfNeeded();
    const msg = message;
    if (msg.meta === 'blockly.event' || msg.meta === 'sprite.proxy' || msg.meta === 'vm.blockListen' || msg.meta === 'vm.shareBlocks' || msg.meta === 'vm.replaceBlocks' || msg.meta === 'vm.updateBitmap' || msg.meta === 'vm.updateSvg' || msg.meta === 'version++') {
        lsVersion++;
    }
    port.postMessage(message, res);
}

let collaborationListener;

const registerChromePortListeners = () => {
    if (coblocksDisabled) { return; }
    port.onMessage.addListener((...args) => { collaborationListener(...args); });
    port.onDisconnect.addListener(() => {
        isConnected = false;
    });
};
// registerChromePortListeners()

function reconnectIfNeeded() {
    if (coblocksDisabled) { return; }
    if (!isConnected) {
        port = window.coBlocksRuntime.connect(exId);
        isConnected = (!!port);
        if (isConnected) {
            registerChromePortListeners();
            liveMessage({ meta: 'myId', id: lsId });
            liveMessage({ meta: 'joinSession' }); // TODO: maybe do away with sending join message?
            if (readyToRecieveChanges) { getAndPlayNewChanges(); }
        }
    }
}

// CoBlocks project state

let lsId = '';
lsVersion = 0;
scratchId = location.pathname.split('/')[2]; //TODO: use better method?
// scratchId = '644532638'
let pauseEventHandling = false;
let projectReplaceInitiated = false;
const onceProjectLoaded = [];
let vm;
let readyToRecieveChanges = false;
let localRecoveryTimer;

function cacheCurrentProjectLocally() {
    if (!lsId || !vm || coblocksDisabled) return;
    try {
        window.coBlocksRuntime.sendMessage(exId, { meta: 'cacheProjectLocally', lsId, scratchId, json: vm.toJSON(), version: lsVersion });
    } catch (error) { console.error('Could not prepare local CoBlocks recovery snapshot:', error); }
}

function startLocalRecoverySnapshots() {
    if (localRecoveryTimer) return;
    localRecoveryTimer = setInterval(cacheCurrentProjectLocally, 60 * 1000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') cacheCurrentProjectLocally();
    });
}

let reloadAfterRestart = false;
async function startCoBlocks(creatingNew) {
    coblocksDisabled = false;
    pauseEventHandling = true;
    liveMessage({ meta: 'myId', id: lsId });
    injectLoadingOverlay();

    activateCoBlocks();
    setTopbarButtonVisibility();

    if (creatingNew || store.getState().scratchGui.projectState.loadingState.startsWith('SHOWING')) {
        if (projectReplaceInitiated) { return; }
        await joinExistingCoBlocks(lsId);
        pauseEventHandling = false;
    } else {
        vm.runtime.on('PROJECT_LOADED', async () => { // todo catch this running after project loads
            if (projectReplaceInitiated) { return; }
            await joinExistingCoBlocks(lsId);
            pauseEventHandling = false;
        });
    }
    if (creatingNew) {
        // addToCredits('Made with BIocklive #blklv')
        creditCollabers([uname]);
    }
}

let coblocksDisabled = false;
async function onTabLoad() {
    if (await acceptCollaborationInvite()) return;

    // Get usable scratch id
    // await waitFor(()=>{!isNaN(parseFloat(location.pathname.split('/')[2]))})
    // scratchId = location.pathname.split('/')[2]
    waitFor(() => (!isNaN(parseFloat(location.pathname.split('/')[2])))).then(() => { scratchId = location.pathname.split('/')[2]; });

    // trap vm and store
    const reactElem = await getObj('div[class^="stage-header_stage-menu-wrapper_"]');
    const reactKey = Object.keys(reactElem).find(k => k.startsWith('__reactFiber'));
    const reactInst = reactElem[reactKey];
    let reactLoopInst = reactInst;
    while (reactLoopInst && (!reactLoopInst.memoizedProps || !reactLoopInst.memoizedProps.vm)) {
        reactLoopInst = reactLoopInst.child;
    }
    vm = reactLoopInst.memoizedProps.vm;
    startLocalRecoverySnapshots();
    reactLoopInst = reactInst;
    while (reactLoopInst && (!reactLoopInst.dependencies || !reactLoopInst.dependencies.firstContext.memoizedValue.store)) {
        reactLoopInst = reactLoopInst.child;
    }
    store = reactLoopInst.dependencies.firstContext.memoizedValue.store;
    injectCoBlocksStyles();
    addButtonInjectors();
    lsId = isNaN(parseFloat(location.pathname.split('/')[2])) ? '' : await getCoBlocksProjectId(scratchId); //todo: should this use the result of the getLsId function, or a more specific endpoint to authenticating project joining?
    if (!lsId) {
        window.coBlocksRuntime.sendMessage(exId, { meta: 'callback' }, (request) => {
            if (request.meta === 'initCoBlocks') {
                lsId = request.lsId;
                startCoBlocks(true);
            }
        });
    }
    if (!!lsId) {
        startCoBlocks();
    } else {
    }
}

onTabLoad();

async function acceptCollaborationInvite() {
    let projectId;
    let token;
    try {
        ({ projectId, token } = JSON.parse(sessionStorage.getItem(pendingInviteKey)) || {});
    } catch {
        sessionStorage.removeItem(pendingInviteKey);
    }
    if (!projectId || !token) return false;

    const response = await new Promise(resolve => {
        window.coBlocksRuntime.sendMessage(exId, { meta: 'acceptInvite', id: projectId, token }, resolve);
    });
    if (!response?.ok) {
        if (response?.status !== 401) sessionStorage.removeItem(pendingInviteKey);
        alert(`Could not accept this CoBlocks invite.\n\n${response?.error || 'The invite may have expired.'}`);
        return false;
    }

    sessionStorage.removeItem(pendingInviteKey);
    location.href = response.scratchId
        ? `https://scratch.mit.edu/projects/${response.scratchId}/editor`
        : 'https://scratch.mit.edu/create';
    return true;
}

async function joinExistingCoBlocks(id) {
    projectReplaceInitiated = true;
    startBLLoadingAnimation();
    // let inpoint = await getInpoint(id)
    const inpoint = await getJson(id, scratchId);

    if (!inpoint || inpoint.err || inpoint.noauth) {
        alert('Could not join CoBlocks project ' + id + '.\n\nError: ' + (inpoint?.err || 'The project could not be authenticated.'));
        finishBLLoadingAnimation();
        pauseEventHandling = false;
        vm.refreshWorkspace();
        removeCoBlocksButtons();
        return;
    }
    const projectJson = inpoint.json;
    pauseEventHandling = true;
    const originalProjectJson = vm.toJSON();
    try {
        revertJSON = originalProjectJson;
        await vm.loadProject(projectJson);
        lsVersion = Number.isFinite(Number(inpoint.version)) ? Number(inpoint.version) : 0;
    } catch (e) {
        finishBLLoadingAnimation();
        try { await vm.loadProject(originalProjectJson); } catch (restoreError) { console.error('Could not restore the editor after a failed recovery load:', restoreError); }
        alert(`CoBlocks refused a damaged project snapshot and restored the project that was already open.\n\nError: ${e}`);
        pauseEventHandling = false;
        readyToRecieveChanges = false;
        removeCoBlocksButtons();
        vm.refreshWorkspace();
        return;
    }

    if (inpoint.recoveredLocally) {
        finishBLLoadingAnimation();
        pauseEventHandling = false;
        readyToRecieveChanges = false;
        alert('CoBlocks recovered this project from the local browser backup. The server copy is unavailable, so live collaboration is paused. Save the Scratch project now to keep this recovered copy.');
        removeCoBlocksButtons();
        vm.refreshWorkspace();
        return;
    }

    await getAndPlayNewChanges(); // sync changes since scratch version
    finishBLLoadingAnimation();
    liveMessage({ meta: 'joinSession' }); // join sessionManager session
    readyToRecieveChanges = true;
    pauseEventHandling = false;
    // hackyRefreshFlyoutVariables()

    setTimeout(BL_UTILS.refreshFlyout, 100); // todo figure way other than timeout

}

function unlinkCoBlocks() {
    if (!confirm('Unlink this Scratch project from CoBlocks? Collaborators will lose access to this copy.')) return;
    window.coBlocksRuntime.sendMessage(exId, { meta: 'leaveScratchId', scratchId });
    removeCoBlocksButtons();
    coblocksDisabled = true;
    port.disconnect();
}

function removeCoBlocksButtons() {
    try {

        // document.querySelector("#app > div > div.gui_menu-bar-position_3U1T0.menu-bar_menu-bar_JcuHF.box_box_2jjDp > div.menu-bar_main-menu_3wjWH > livescratchcontainer")?.remove()
        document.querySelector('#lsRevert')?.remove();
        document.querySelector('#noRefreshPanel')?.remove();
        document.querySelector('#lsUsersPanel')?.remove();
        document.querySelector('#ls-chat')?.remove();
        document.querySelector('#lsNativeBackpack')?.remove();
        resizeEditorForBackpack();

        lsDropdown.style.display = 'none';
        coblocksButton.onclick = lsActivateClick;

    } catch (e) { console.error(e); }
    lsId = null;
}

function getCoBlocksProjectId(scratchId) {
    return new Promise((promRes) => {
        window.coBlocksRuntime.sendMessage(exId, { meta: 'getLsId', scratchId }, promRes);
    });
}
// function getInpoint(livescratchId) {
//     return new Promise((res)=>{window.coBlocksRuntime.sendMessage(exId,{meta:'getInpoint',lsId:livescratchId},res)})
// }
function getJson(livescratchId, currentScratchId) {
    return new Promise((res) => { window.coBlocksRuntime.sendMessage(exId, { meta: 'getJson', lsId: livescratchId, scratchId: currentScratchId }, res); });
}
function getChanges(lsId, version) {
    return new Promise((res) => { window.coBlocksRuntime.sendMessage(exId, { meta: 'getChanges', lsId, version }, res); });
}
function fetchTitle(lsId) {
    return new Promise((res) => { window.coBlocksRuntime.sendMessage(exId, { meta: 'getTitle', lsId }, res); });
}

function setTopbarButtonVisibility() {
    try {
        if (!lsId || typeof lsCursors === 'undefined' || Object.entries(Object(lsCursors)).length === 0) { document.getElementById('lsUsersPanel').style.visibility = 'hidden'; } else { document.getElementById('lsUsersPanel').style.visibility = 'visible'; }
    } catch (e) { console.error(e); }
    try {
        const chatElem = document.getElementById('lsChatButton');
        if (!lsId) { chatElem.style.visibility = 'hidden'; chatElem.style.display = 'none'; } else { chatElem.style.visibility = 'visible'; chatElem.style.display = 'flex'; }
    } catch (e) { console.error(e); }
}

let getAndPlayNewChanges;

async function activateCoBlocks() {
    startCollaboratorPointers();
    addChat();
    mountSharedBackpack().catch(error => console.error('Could not mount the CoBlocks backpack:', error));

    playChanges = async (changes) => {
        if (changes.forceReload) { forceReload(); }

        pauseEventHandling = true;
        for (let i = 0; i < changes.length; i++) {
            await collaborationListener(changes[i]);
        }
        if (changes.currentVersion) { lsVersion = changes.currentVersion; }
        pauseEventHandling = false;

        vm.emitWorkspaceUpdate();
        vm.emitTargetsUpdate();
    };

    // set scope exposed functions
    getAndPlayNewChanges = async () => {

        fetchTitle(lsId).then(title => setTitle(title)); // set title

        // sync all other project changes
        changes = await getChanges(lsId, lsVersion);
        if (typeof BL_UTILS !== 'undefined' && BL_UTILS.isDragging()) {
            playAfterDragStop.push({ meta: 'resyncCached', changes });
        } else {
            await playChanges(changes);
        }
    };

    function forceReload() {
        window.onbeforeunload = null;
        location.reload();
    }

    ///.......... CONNECT TO CHROME PORT ..........//

    function connectFirstTime() {
        reconnectIfNeeded();
    // request for livescratchId
    // liveMessage({meta:"hiimhungry"})
    }
    connectFirstTime();

    setInterval(reconnectIfNeeded, 1000);

    /// other things

    collaborationListener = async (msg) => {
        if (coblocksDisabled) { return; }
        if (msg.meta === 'pointer') {
            receiveCollaboratorPointer(msg.username, msg.pointer);
            return;
        }
        if (typeof BL_UTILS !== 'undefined' && BL_UTILS.isDragging()) {
            // dong add to list if its a move event on the current moving block
            if (msg.meta === 'vm.blockListen' && msg.type === 'move' && msg.event.blockId === BL_UTILS.getDraggingId()) { return; } else { playAfterDragStop.push(msg); }
            return;
        }

        if (!!msg.version) { lsVersion = msg.version - 1; } // TODO: possibly disable this
        try {
            if (msg.meta === 'resyncCached') {
            // remember to await shit
                await playChanges(msg.changes);
            } else if (msg.meta === 'sprite.proxy') {
                lsVersion++;
                await proxyActions[msg.data.name](...(['linguini'].concat(msg.data).concat(msg.data.args)));
            } else if (msg.meta === 'vm.blockListen') {
                lsVersion++;
                onBlockRecieve(msg);
            } else if (msg.meta === 'messageList') {
                for (let i = 0; i < msg.messages.length; i++) {
                    await collaborationListener(msg.messages[i]);
                }
            } else if (msg.meta === 'vm.shareBlocks') {
                lsVersion++;
                doShareBlocksMessage(msg);
            } else if (msg.meta === 'vm.replaceBlocks') {
                if (!nameToTarget(msg.target)?.blocks) {
                    addNewTargetEvent(msg.target, msg);
                } else {
                    lsVersion++;
                    replaceBlockly(msg);
                }
            } else if (msg.meta === 'vm.updateBitmap') { // TODO: Do this better-- pass in changes from bg script
                lsVersion++;
                await updateBitmap(msg);
            } else if (msg.meta === 'vm.updateSvg') { // TODO: Do this better-- pass in changes from bg script
                lsVersion++;
                await updateSvg(msg);
            } else if (msg.meta === 'yourVersion') {
                lsVersion = msg.version;
            } else if (msg.meta === 'setTitle') {
                setTitle(msg.title);
            } else if (msg.meta === 'resync') { // TODO: Do this better-- pass in changes from bg script
                if (readyToRecieveChanges) { getAndPlayNewChanges(); }
            } else if (msg.meta === 'version++') {
                lsVersion++;
            } else if (msg.meta === 'chat') {
                addMessage(msg.msg, true);
            } else if (msg.meta === 'presence') {
                if (msg.action === 'leave') removeCollaboratorPointer(msg.username);
                const joined = msg.action === 'join';
                addCoBlocksNotification({
                    type: joined ? 'join' : 'leave',
                    title: `@${msg.username} ${joined ? 'joined' : 'left'}`,
                    message: joined ? 'They are now editing this project.' : 'They stopped editing this project.',
                    action: 'collaboration',
                });
                refreshCollaborationPresence();
            } else if (msg.meta === 'openChat') {
                if (document.querySelector('ls-chat')) toggleChat(true);
            } else if (msg.meta === 'backpack.updated') {
                if (document.querySelector('#lsNativeBackpack')) refreshSharedBackpack();
            }
        } catch (e) { console.error(e); }
    };


    ///.......... TRAPS ..........//
    // Thanks garbomuffin and scratchaddons for guidance

    // set helpful function to download projet and return the promise
    async function downloadProjectIdPromise (id) {
        const storage = this.runtime.storage;
        if (!storage) {
            log.error('No storage module present; cannot load project: ', id);
            return;
        }
        const vm = this;
        const promise = storage.load(storage.AssetType.Project, id);
        projectAsset = await promise;
        return vm.loadProject(projectAsset.data);
    }
    vm.downloadProjectIdPromise = downloadProjectIdPromise.bind(vm);

    // Trap ScratchBlocks - rewrote for react 18 by waakul

    listenForObj('[class^="gui_blocks-wrapper"]', (reactElem) => {
        const reactKey = Object.keys(reactElem).find(k => k.startsWith('__reactFiber'));
        const reactInst = reactElem[reactKey];
        let reactLoopInst = reactInst;
        while (reactLoopInst && (!reactLoopInst.stateNode || !reactLoopInst.stateNode.ScratchBlocks)) {
            reactLoopInst = reactLoopInst.child;
        }
        if (!reactLoopInst?.stateNode?.ScratchBlocks) return;
        ScratchBlocks = reactLoopInst.stateNode.ScratchBlocks; //reactInst.child.child.child.child.child.child.child.stateNode.ScratchBlocks;
        // Scratch no longer reliably exposes a Blockly global with
        // getMainWorkspace(). ScratchBlocks is the editor's live instance.
        if (typeof window.Blockly?.getMainWorkspace !== 'function') window.Blockly = ScratchBlocks;
        const workspace = getWorkspace();
        workspace?.removeChangeListener(blockListener);
        workspace?.addChangeListener(blockListener);
    });

    // Trap Paint
    function getPaper() {
        const paperContainer = document.querySelector('[class^=\'paint-editor_canvas-container\']');
        if (!paperContainer) return null;
        const reactKey = Object.keys(paperContainer).find(k => k.startsWith('__reactFiber'));
        const reactInst = paperContainer[reactKey];
        let reactLoopInst = reactInst;
        while (reactLoopInst && (!reactLoopInst.stateNode || !reactLoopInst.stateNode.canvas)) {
            reactLoopInst = reactLoopInst.child;
        }
        return reactLoopInst.stateNode;
    }

    ///.......... ALL THE HACKY THINGS ..........//



    function isWorkspaceAccessable() {
        return !!document.querySelector('.blocklyWorkspace');
    }

    function getWorkspace() {
        return window.Blockly?.getMainWorkspace?.();
    }
    function getWorkspaceId() {
        return getWorkspace()?.id;
    }

    function getDraggingId() {
        return window.Blockly?.getMainWorkspace?.()?.currentGesture_?.targetBlock?.id;
    }
    function isDragging() {
        return window.Blockly?.getMainWorkspace?.()?.isDragging();
    }

    // STAGE IDENTIFIER. DO NOT SET SPRITE NAME TO THIS UNLESS YOU WANT TO PURPOSEFULLY BREAK LINKAGE!!!!
    const stageName = 'jHHVSbKjDsRhSWhIlYtd...___+_0)0+-amongus';
    function targetToName(target) {
        return target?.isStage ? stageName : target?.sprite.name;
    }
    function nameToTarget(name) {
        return name === stageName ? vm.runtime.getTargetForStage() : vm.runtime.getSpriteTargetByName(name);
    }

    // Credit to GarboMuffin and apple502j https://github.com/ScratchAddons/ScratchAddons/blob/399e2e51ca43e9299c8d07ff315b91966c7c1a5e/addons/onion-skinning/userscript.js#L428
    const getSelectedCostumeIndex = () => {
        const item = document.querySelector('[class*=\'selector_list-item\'][class*=\'sprite-selector-item_is-selected\']');
        if (!item) return -1;
        const numberEl = item.querySelector('[class*=\'sprite-selector-item_number\']');
        if (!numberEl) return -1;
        return +numberEl.textContent - 1;
    };

    function refreshFlyout() {
        vm.emitWorkspaceUpdate();
        // update flyout for new variables and blocks
        if (!BL_UTILS.isWorkspaceAccessable()) { return; }
        BL_UTILS.getWorkspace().getToolbox().refreshSelection();
        setTimeout(() => {
            if (BL_UTILS.isWorkspaceAccessable()) {
                BL_UTILS.getWorkspace().toolboxRefreshEnabled_ = true;
            }
        }, 130);
    }
    BL_UTILS = {
        isWorkspaceAccessable,
        getWorkspace,
        getWorkspaceId,
        getDraggingId, isDragging,
        targetToName,
        nameToTarget,
        getSelectedCostumeIndex,
        refreshFlyout,
    };

    BL_UTILS.stageName = stageName;

    // send to api when project saved and name change
    let lastProjectState = store.getState().scratchGui.projectState.loadingState;
    let lastTitle = store.getState().preview.projectInfo.title;
    let settingTitle = null;
    let titleYetUnset = true;
    setTimeout(() => { titleYetUnset = false; }, 1000 * 2);

    store.subscribe(function() {
    // HANDLE PROJECT SAVE
        const state = store.getState().scratchGui.projectState.loadingState;
        if (lastProjectState !== state) { // If state changed
            lastProjectState = store.getState().scratchGui.projectState.loadingState;
            if (state.endsWith('UPDATING')) {
                window.coBlocksRuntime.sendMessage(exId, { meta: 'projectSavedJSON', lsId, scratchId, json: vm.toJSON(), version: lsVersion });
            // window.coBlocksRuntime.sendMessage(exId,{meta:'projectSaved',lsId,scratchId,version:lsVersion})
            }
            try {
                if (state === 'SHOWING_WITH_ID') {
                    finishedSavingCB.forEach((func) => { func(); });
                }
            } catch (e) { console.error(e); }
        }

        // HANDLE TITLE CHANGE
        const title = store.getState().preview.projectInfo.title;
        if (title !== lastTitle && !titleYetUnset) {
            lastTitle = title;
            if (title !== settingTitle) {
                liveMessage({ meta: 'setTitle', lsId, title });
            }
        }
    });


    function setTitle(title) {
        settingTitle = title;
        const elem = document.querySelector('#frc-title-1088'); //Todo: query id
        if (elem) {
            Object.entries(elem).find(en => en[0].startsWith('__reactEventHandlers$'))[1].onBlur({ currentTarget: { value: title } });
        } else {
            store.dispatch({
                type: 'projectTitle/SET_PROJECT_TITLE',
                title,
            });
        }
    }



    function replaceBlockly(msg) {
    // replace a target's block data (used for syncing id's on sprite duplicate)
        const target = nameToTarget(msg.target);
        const blocks = target.blocks;
        Object.keys(blocks._blocks).forEach(v => { blocks.deleteBlock(v); });
        Object.values(msg.blocks).forEach(block => { blocks.createBlock(block); });
        if (targetToName(vm.editingTarget) === targetToName(target)) { vm.emitWorkspaceUpdate(); }
    }


    proxyActions = {};
    //action: vm action function
    //name: name to put in recort
    //mutator: args generator from recieved data object (has args field)
    //then: callback for those replaying action

    // mutator takes data object {name, args, extrargs} and returns args list

    let prevTarg = null;
    function editingProxy(action, name, before, after, extrargs, mutator) {
        return proxy(action, name,
            (a) => ({ target: targetToName(vm.editingTarget), ...(extrargs ? extrargs(a) : null) }), mutator,
            (data) => {
                if (!!before) { before(data); }
                prevTarg = vm.editingTarget;
                vm.editingTarget = nameToTarget(data.extrargs.target);
                vm.runtime._editingTarget = vm.editingTarget;
            },
            (_a, _b, data) => {
                if (!prevTarg) { 'PREVTARG IS UNDEFINED'; }
                if (!!prevTarg && !!vm.runtime.getTargetById(prevTarg.id)) {
                    vm.editingTarget = prevTarg;
                    vm.runtime._editingTarget = prevTarg;
                }
                vm.emitTargetsUpdate();
                if (!!after) { after(_a, _b, data); }
            });
    }

    function proxy(action, name, extrargs, mutator, before, then, dontSend, dontDo, senderThen) {
        return anyproxy(vm, action, name, extrargs, mutator, before, then, dontSend, dontDo, senderThen);
    }
    function anyproxy(bindTo, action, name, extrargs, mutator, before, then, dontSend, dontDo, senderThen) {
        const proxiedFunction = function(...args) {
            if (args[0] === 'linguini') {
                // if linguini, ...args are ['linguini', data, data.args]
                args.splice(0, 1);
                const data = args.splice(0, 1)[0];
                if (mutator) { args = mutator(data); }
                // else {args = data.args}

                const prevTarget = vm.editingTarget;
                if (!!before) { before(data); }
                if (dontDo?.(data)) { return; }
                proxiedArgs = args;
                let retVal;
                try { retVal = action.bind(bindTo)(...args); } catch (e) { console.error('error on proxy run', e); }
                if (then) {
                    if (!!retVal?.then) {
                    // if returns a promise
                        retVal.then((res) => { then(prevTarget, vm.editingTarget, data, res); });
                    } else {
                    // if is normal resolved function
                        then(prevTarget, vm.editingTarget, data, retVal);
                    }
                }
                return retVal;
            } else {
                if (pauseEventHandling) {
                    return action.bind(bindTo)(...args);
                } else {
                    let extrargsObj = null;
                    if (!!extrargs) { extrargsObj = extrargs(args); }
                    proxiedArgs = args;

                    const retVal = action.bind(bindTo)(...args);
                    if (!dontSend?.(...args)) { liveMessage({ meta: 'sprite.proxy', data: { name, args, extrargs: extrargsObj } }); }
                    if (senderThen) {
                        if (!!retVal?.then) {
                            // if returns a promise
                            retVal.then(senderThen);
                        } else {
                            // if is normal resolved function
                            senderThen();
                        }
                    }
                    return retVal;
                }
            }
        };
        proxyActions[name] = proxiedFunction;
        return proxiedFunction;
    }

    function asyncEditingProxy(action, name, before, after, extrargs, mutator) {
        return asyncAnyproxy(vm, action, name,
            (a) => ({ target: targetToName(vm.editingTarget), ...(extrargs ? extrargs(a) : null) }), mutator,
            (data) => {
                if (!!before) { before(data); }
                prevTarg = vm.editingTarget;
                vm.editingTarget = nameToTarget(data.extrargs.target);
                vm.runtime._editingTarget = vm.editingTarget;
            },
            (_a, _b, data) => {
                if (!prevTarg) { 'PREVTARG IS UNDEFINED'; }
                if (!!prevTarg && !!vm.runtime.getTargetById(prevTarg.id)) {
                    vm.editingTarget = prevTarg;
                    vm.runtime._editingTarget = prevTarg;
                }
                vm.emitTargetsUpdate();
                if (!!after) { after(_a, _b, data); }
            });
    }

    function asyncAnyproxy(bindTo, action, name, extrargs, mutator, before, then, dontSend, dontDo, senderThen) {
        const proxiedFunction = async function(...args) {
            if (args[0] === 'linguini') {
                // if linguini, ...args are ['linguini', data, data.args]
                args.splice(0, 1);
                const data = args.splice(0, 1)[0];
                if (mutator) { args = await mutator(data); }
                // else {args = data.args}

                const prevTarget = vm.editingTarget;
                if (!!before) { before(data); }
                if (dontDo?.(data)) { return; }
                proxiedArgs = args;
                let retVal;
                try { retVal = action.bind(bindTo)(...args); } catch (e) { console.error('error on proxy run', e); }
                if (then) {
                    if (!!retVal?.then) {
                    // if returns a promise
                        retVal.then((res) => { then(prevTarget, vm.editingTarget, data, res); });
                    } else {
                    // if is normal resolved function
                        then(prevTarget, vm.editingTarget, data, retVal);
                    }
                }
                return retVal;
            } else {
                if (pauseEventHandling) {
                    return action.bind(bindTo)(...args);
                } else {
                    let extrargsObj = null;
                    if (!!extrargs) { extrargsObj = extrargs(args); }
                    proxiedArgs = args;

                    const retVal = action.bind(bindTo)(...args);
                    if (!dontSend?.(...args)) { liveMessage({ meta: 'sprite.proxy', data: { name, args, extrargs: extrargsObj } }); }
                    if (senderThen) {
                        if (!!retVal?.then) {
                            // if returns a promise
                            retVal.then(senderThen);
                        } else {
                            // if is normal resolved function
                            senderThen();
                        }
                    }
                    return retVal;
                }
            }
        };
        proxyActions[name] = proxiedFunction;
        return proxiedFunction;
    }


    // todo catch shadow create
    function isBadToSend(event, target) {
        switch (event.type) {
        // filter out shadow events that shouldnt be proxied
            case 'create': if (event.xml.nodeName === 'SHADOW') { return true; }
            case 'delete': if (event.oldXml?.nodeName === 'SHADOW') { return true; }
            case 'move' : {
                const block = target.blocks.getBlock(event.blockId);
                if (block?.shadow) { return true; }

            // edge case: c1 move unlinked var block into parent block. c2 livescratch mistakenly moves a linked block into that place. c2 moves linked block out of the parent block and does not move out of c1
            // dont send if moves a varible to same position
            // if(!!block && (block.fields.VARIABLE || block.fields.LIST)) {
            //     if(!!event.oldCoordinate && !!event.newCoordinate && (
            //         Math.round(event.oldCoordinate.x) === Math.round(event.newCoordinate.x) &&
            //         Math.round(event.oldCoordinate.y) === Math.round(event.newCoordinate.y)
            //     )) {return true}
            // }
            }
        }
        return false;
    }

    // Todo catch bad deletes (var, comment)
    // get current drag id
    // ScratchBlocks.getMainWorkspace().getBlockDragSurface().getCurrentBlock()?.getAttribute('data-id')

    function isBadToRun(event, target) {
        switch (event.type) {
        // dont run if block already exists
            case 'create': return !!target.blocks.getBlock(event.blockId);
            case 'delete': return !target.blocks.getBlock(event.blockId);
                // dont run if comment already exists
            case 'comment_create': return event.commentId in target.comments;
            case 'move': {
            // dont run if block doesnt exist
                if (!target.blocks.getBlock(event.blockId)) return true;
                // dont run if block is already close enough to position (rounded to 1's place)
                // ...and make sure that the event specifies x and y before checking!
                if (!!event.newCoordinate?.x && !!event.newCoordinate?.y) {
                    const localBlock = target.blocks.getBlock(event.blockId);
                    if (Math.round(localBlock.x) === Math.round(event.newCoordinate.x) &&
                Math.round(localBlock.y) === Math.round(event.newCoordinate.y)) { return true; }
                }
                // dont run if newParentId is the same (assuming exists)
                if (!!event.newParentId) {
                    const localBlock = target.blocks.getBlock(event.blockId);
                    if (localBlock.parent === event.newParentId) { return true; }
                }
            }
        }
        return false;
    }
    // Interface with ScratchBlocks object
    function isBadToRunBlockly(event, workspace) {
        switch (event.type) {
        // dont run if block already exists
            case 'create': return !!workspace.getBlockById(event.blockId);
        }

    }

    function getStringEventRep(e) {
        let rep = e.type + e.blockId + e.commentId + e.varId;
        switch (e.type) {
            case 'move':
                rep += parseInt(e.newCoordinate?.x) + ''
            + parseInt(e.newCoordinate?.y) + ''
            + e.newParentId + '';
                break;
            case 'change':
                rep += e.name + e.newValue + e.element;
                break;
            case 'var_create':
                rep += e.varName + e.isCloud + e.isLocal;
                break;
            case 'var_delete':
                rep += e.varName + e.isCloud + e.isLocal;
                break;
            case 'var_rename':
                rep += e.newName;
                break;
            case 'comment_change':
                rep += JSON.stringify(e.newContents_, (k, v) => (v?.toFixed ? Number(v.toFixed(0)) : v));
                break;
            case 'comment_move':
                rep += Math.round(e.newCoordinate_?.x)
            + Math.round(e.newCoordinate_?.y);
                break;
        }
        return rep.replaceAll('undefined', 'null');
    }

    oldBlockListener = vm.blockListener;
    remoteEvents = {};
    createEventMap = {};
    toBeMoved = {};
    // listen to local blockly events
    function blockListener(e) {
        if (pauseEventHandling) { return; }
        if (e.type === 'ui') { uiii = e; }
        if (e.type === 'create') { createe = e; }
        if (e.type === 'delete') { deletee = e; }
        if (e.type === 'change') { changee = e; }
        if (e.type === 'move') { movee = e; }
        if (e.type === 'comment_change') { comee = e; }
        // filter ui events and livescratch
        const stringRep = getStringEventRep(e);
        if (stringRep in remoteEvents) { delete remoteEvents[stringRep]; } else if (
            !e.isCoBlocks &&
        !e.isUiEvent &&
        ['endDrag', 'ui', 'dragOutside'].indexOf(e.type) === -1 &&
        !isBadToSend(e, vm.editingTarget) &&
        e.element !== 'stackclick'
        ) {
            const extrargs = {};

            // send variable locator info
            if (e.type === 'move') {
                const block = vm.editingTarget.blocks.getBlock(e.blockId);
                if (!!block && (block.fields.VARIABLE || block.fields.LIST)) {
                    extrargs.blockVarId = block.fields.VARIABLE ? block.fields.VARIABLE.id : block.fields.LIST.id;
                }
            } else if (e.type === 'change' && (e.name === 'VARIABLE' || e.name === 'LIST')) {
                const block = vm.editingTarget.blocks.getBlock(e.blockId);
                if (!!block && (
                    block.opcode === 'data_variable' || block.opcode === 'data_listcontents'
                )) {
                    extrargs.blockVarId = e.oldValue;
                    extrargs.blockVarParent = block.parent;
                    extrargs.blockVarPos = { x: block.x, y: block.y };
                    extrargs.blockVarInput = Object.values(new Object(vm.editingTarget.blocks.getBlock(block.parent)?.inputs))?.find(input => (input.block === e.blockId))?.name;
                }
            } else if (e.type === 'delete' && (
                e.oldXml?.firstElementChild?.getAttribute('name') === 'VARIABLE' ||
            e.oldXml?.firstElementChild?.getAttribute('name') === 'LIST'
            )) {
                const block = !!vm.editingTarget.blocks._blocks[e.blockId] ? vm.editingTarget.blocks._blocks[e.blockId] : lastDeletedBlock;
                extrargs.blockVarId = block.fields.VARIABLE ? block.fields.VARIABLE.id : block.fields.LIST.id;
                extrargs.blockVarParent = block.parent;
                extrargs.blockVarPos = { x: block.x, y: block.y };
                extrargs.blockVarInput = Object.values(new Object(vm.editingTarget.blocks.getBlock(block.parent)?.inputs))?.find(input => (input.block === e.blockId))?.name;
            }

            // send field locator info
            if (e.element === 'field') {
                if (vm.editingTarget.blocks.getBlock(e.blockId).shadow) {
                    const fieldInputId = e.blockId;
                    const fieldInput = vm.editingTarget.blocks.getBlock(fieldInputId);
                    const parentId = fieldInput.parent;
                    if (!!parentId) {
                        const parentBlock = vm.editingTarget.blocks.getBlock(parentId);
                        const inputTag = Object.values(new Object(parentBlock.inputs)).find(input => input.shadow === fieldInputId).name;

                        extrargs.parentId = parentId;
                        extrargs.fieldTag = inputTag;
                    }
                }
            }

            // send broadcast name (in case of auto broadcast delete on recieving client)
            if (e.type === 'change' && e.name === 'BROADCAST_OPTION') {
                extrargs.broadcastName = vm.runtime.getTargetForStage().variables[e.newValue]?.name;
                extrargs.broadcastId = vm.runtime.getTargetForStage().variables[e.newValue]?.id;
            }

            // send block xml-related things
            if (!!e.xml) {
                extrargs.xml = { outerHTML: e.xml.outerHTML };
                extrargs.isCBCreateOrDelete = e.xml?.getAttribute('type') === 'procedures_definition';
            }
            if (!!e.oldXml) {
                extrargs.isCBCreateOrDelete = extrargs.isCBCreateOrDelete || e.oldXml?.getAttribute('type') === 'procedures_definition';
            }


            let message = { meta: 'vm.blockListen', type: e.type, extrargs, event: e, json: e.toJson(), target: targetToName(vm.editingTarget) };

            // intercept and save create events to send later
            if (e.type === 'create') {
                createEventMap[e.blockId] = message;
                // } else if (e.type === 'comment_create') { //TODO: maybe add back
                //     createEventMap[e.commentId] = message
                // intercept auto generated move event
            } else if ((e.type === 'move') && e.blockId in toBeMoved) {
                const moveEvents = toBeMoved[e.blockId];
                delete toBeMoved[e.blockId];
                moveEvents.forEach(moveMessage => onBlockRecieve(moveMessage));
            } else {
            // send held off create events
                if (e.blockId in createEventMap) {
                // erase from face of existance
                    if (e.type === 'delete') {
                        message = null;
                    } else {
                        liveMessage(createEventMap[e.blockId]);
                    // setTimeout(()=>{liveMessage(createEventMap[e.blockId])},5000 )
                    }
                    delete createEventMap[e.blockId];
                }
                if (e.commentId in createEventMap) {
                    if (e.type === 'comment_delete') {
                        message = null;
                    } else {
                        liveMessage(createEventMap[e.commentId]);
                    // setTimeout(()=>{liveMessage(createEventMap[e.commentId]) },5000)
                    }
                    delete createEventMap[e.commentId];
                }
                if (!!message) {
                    liveMessage(message);

                // setTimeout(()=>{liveMessage(message)},5000)
                }
            }
        }
    // ___DONT___ Forward (do) event
    // oldBlockListener(e)
    }

    /// Todo: testing on whether or not to actually execute actions
    // Todo: catch stage not being sprite
    // Remove thing from undo list

    function getDistance(p1, p2) {
        return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    }

    function onBlockRecieve(d) {

        // for comment parsing cause they did the toJson wrong apparently
        if (d.type === 'comment_change') {
            d.json.newValue = d.json.newContents;
        }

        const oldEditingTarget = vm.editingTarget;
        // set editing target
        vm.editingTarget = nameToTarget(d.target);
        vm.runtime._editingTarget = vm.editingTarget;

        // pause workspace updating
        pauseWorkspaceUpdating();

        try {
            const vEvent = d.event;
            let bEvent = {};
            if (isWorkspaceAccessable()) {
                bEvent = ScratchBlocks.Events.fromJson(d.json, getWorkspace());
            }
            //set blockly event tag
            bEvent.isCoBlocks = true;

            //........... Modify event ...........//

            // set vm type
            vEvent.type = d.type;

            // find true variable block if needed
            if (d.extrargs.blockVarId && !(d.event.blockId in toBeMoved) && !vm.editingTarget.blocks.getBlock(d.event.blockId)) {
                if (d.event.oldParentId || d.extrargs.blockVarParent) {
                    const oldParentId = d.extrargs.blockVarParent ? d.extrargs.blockVarParent : d.event.oldParentId;
                    const realId = vm.editingTarget.blocks.getBlock(oldParentId).inputs[d.extrargs.blockVarInput ? d.extrargs.blockVarInput : d.event.oldInputName].block;
                    vEvent.blockId = realId;
                    bEvent.blockId = realId;
                    if (d.type === 'delete') {
                        bEvent.ids = [realId];
                        vEvent.ids = [realId];
                    }
                } else if (d.event.oldCoordinate || d.extrargs.blockVarPos) {
                    const oldCoordinate = d.extrargs.blockVarPos ? d.extrargs.blockVarPos : d.event.oldCoordinate;
                    const varBlocks = vm.editingTarget.blocks._scripts.filter((blockId) => {
                        const block = vm.editingTarget.blocks.getBlock(blockId);
                        return (
                            block?.fields?.VARIABLE?.id === d.extrargs.blockVarId ||
                    block?.fields?.LIST?.id === d.extrargs.blockVarId
                        );
                    });
                    let closestBlock;
                    let closestDistance = -1;
                    varBlocks.forEach(blockId => {
                        const block = vm.editingTarget.blocks.getBlock(blockId);
                        if (!block.parent) {
                            const distance = getDistance({ x: block.x, y: block.y }, oldCoordinate);
                            if (!closestBlock || distance < closestDistance) {
                                closestBlock = block;
                                closestDistance = distance;
                            }
                        }
                    });
                    if (closestBlock) {
                        vEvent.blockId = closestBlock.id;
                        bEvent.blockId = closestBlock.id;
                        if (d.type === 'delete') {
                            bEvent.ids = [closestBlock.id];
                            vEvent.ids = [closestBlock.id];
                        }
                    }
                }
            }

            //find true field
            const queueUpdate = false;
            if (!!d.extrargs.fieldTag) {
                const realId = vm.editingTarget.blocks.getBlock(d.extrargs.parentId).inputs[d.extrargs.fieldTag].shadow;
                // queueUpdate = vm.editingTarget.blocks.getBlock(realId)?.opcode === 'sensing_of_object_menu' // workspace update if updates mid-
                vEvent.blockId = realId;
                bEvent.blockId = realId;
            }

            // create broadcast if needed
            if (!!d.extrargs.broadcastName && !vm.runtime.getTargetForStage().variables[d.json.newValue]) {
                const createVmEvent = { isCloud: false, isLocal: false, type: 'var_create', varId: d.extrargs.broadcastId, varName: d.extrargs.broadcastName, varType: 'broadcast_msg' };
                vm.blockListener(createVmEvent);

                if (isWorkspaceAccessable()) {
                    const createBlEvent = ScratchBlocks.Events.fromJson(createVmEvent, getWorkspace());
                    remoteEvents[getStringEventRep(createBlEvent)] = true;
                    createBlEvent.run(true);
                }
            }

            //xml
            if (!!d.extrargs.xml) {
                vEvent.xml = d.extrargs.xml;
            }

            // add comment create xy
            if (d.type === 'comment_create') {
                bEvent.xy = d.event.xy;
            }

            if (
                (
                    (targetToName(oldEditingTarget) === d.target && !pauseEventHandling) || // if in same editing target that event is for
            (['var_create', 'var_delete'].indexOf(d.type) !== -1 && !d.json.isLocal) // or if event is a global variable create or delete
                )
        && isWorkspaceAccessable() // and no matter what make sure that workspace is accessable
            ) {
                // save speedy move and delete events for later
                if ((bEvent.type === 'move' || bEvent.type === 'delete') && bEvent.blockId in toBeMoved) { toBeMoved[bEvent.blockId].push(d); } else {
                    //inject directly into blockly
                    if (!isBadToRunBlockly(bEvent, getWorkspace()) && !isBadToRun(bEvent, vm.editingTarget)) {
                        // record newly made block so that we can intercept it's blockly auto-generated move event later
                        // ...dont record it for newly created custom block definitions
                        if (bEvent.type === 'create' && !d.extrargs.isCBCreateOrDelete) { toBeMoved[bEvent.blockId] = []; }
                        // record played livescratch event
                        remoteEvents[getStringEventRep(bEvent)] = true;
                        // run event

                        // try to add transition element stuff
                        // if(false ) {
                        if (bEvent.type === 'move') {
                            const blockElement = getWorkspace()?.getBlockById(bEvent.blockId)?.getSvgRoot();
                            if (blockElement) {
                                blockElement.style.transition = 'transform 0.5s';
                            }
                        }
                        // }

                        // blockElement?.style.transitionProperty='transform';

                        bEvent.run(true);
                        // blockElement?.style.transition='transform 0.5s';

                        lastEventRun = bEvent;

                        // for custom blocks, update toolbox
                        if (bEvent.element === 'mutation' || d.extrargs.isCBCreateOrDelete) {
                            getWorkspace().getToolbox().refreshSelection();
                        }

                        // highlight blocks
                        if (['create', 'move', 'change'].indexOf(bEvent.type)) {
                            const blockId = bEvent.blockId;
                            try {
                                outlineBlock(blockId, d.user);
                            } catch (e) { console.error(e); }
                        }
                        // 'comment_create','comment_change','comment_move'

                    }
                }
            } else {
                if (!isBadToRun(vEvent, vm.editingTarget)) {
                    vm.editingTarget.blocks.blocklyListen(vEvent);
                }
            }
        } catch (e) { console.error('error on block event execution', e); }
        //reset editing target
        if (oldEditingTarget && vm.runtime.getTargetById(oldEditingTarget.id)) {
            vm.editingTarget = oldEditingTarget;
            vm.runtime._editingTarget = oldEditingTarget;
        }
        continueWorkspaceUpdating();
    }

    const oldTargUp = vm.emitTargetsUpdate.bind(vm);
    // window.BL_UTILS.unsafeTargetsUpdate=oldTargUp;
    window.etuListeners = [];
    vm.emitTargetsUpdate = function(...args) {
        etuListeners.forEach(e => { try { e?.(); } catch (e) { console.error(e); } });
        etuListeners = [];
        if (pauseEventHandling) { return; } else { oldTargUp(...args); }

    // move my bubble
        //    moveMyBubble()
    };

    const oldEWU = (vm.emitWorkspaceUpdate).bind(vm);

    bl_workspaceUpdatingPaused = false;
    bl_workspaceUpdateRequested = false;
    function pauseWorkspaceUpdating() {
        bl_workspaceUpdatingPaused = true;
    }
    function continueWorkspaceUpdating() {
        bl_workspaceUpdatingPaused = false;
        if (bl_workspaceUpdateRequested) { vm.emitWorkspaceUpdate(); }
        bl_workspaceUpdateRequested = false;
    }

    vm.emitWorkspaceUpdate = function() {
        if (pauseEventHandling) return;
        if (bl_workspaceUpdatingPaused) {
            bl_workspaceUpdateRequested = true;
            return;
        }
        if (!isWorkspaceAccessable()) { return; }

        // add deletes for comments
        getWorkspace()?.getTopComments().forEach(comment => {
            remoteEvents[getStringEventRep({ type: 'comment_delete', commentId: comment.id })] = true;
        });
        // add creates for comments in new workspace
        Object.keys(vm.editingTarget.comments).forEach(commentId => {
            remoteEvents[getStringEventRep({ type: 'comment_create', commentId })] = true;
        });
        // add deletes for top blocks in current workspace
        (getWorkspace()?.getTopBlocks?.(false) ?? []).forEach(block => {
            remoteEvents[getStringEventRep({ type: 'delete', blockId: block.id })] = true;
        });
        // add creates for all blocks in new workspace
        Object.keys(vm.editingTarget.blocks._blocks).forEach(blockId => {
            remoteEvents[getStringEventRep({ type: 'create', blockId })] = true;
            const block = vm.editingTarget.blocks._blocks[blockId];
            if (!block.parent) {
                const moveRep = getStringEventRep({
                    type: 'move',
                    blockId,
                    newCoordinate: { x: block.x, y: block.y },
                    newParentId: block.parent,
                });
                remoteEvents[moveRep] = true;
            }
        });
        // add var creates and deletes
        Object.entries(vm.editingTarget.variables).forEach(varr => {
            remoteEvents[getStringEventRep({ type: 'var_delete', varId: varr[0], isCloud: varr[1].isCloud, varName: varr[1].name, isLocal: false })] = true;
            remoteEvents[getStringEventRep({ type: 'var_create', varId: varr[0], isCloud: varr[1].isCloud, varName: varr[1].name, isLocal: true })] = true;
        });
        // add global (local:false) var creates
        Object.entries(vm.runtime.getTargetForStage().variables).forEach(varr => {
        // remoteEvents[getStringEventRep({type:'var_delete',varId:varr[0],isCloud:varr[1].isCloud,varName:varr[1].name,isLocal:false})] = true
            remoteEvents[getStringEventRep({ type: 'var_create', varId: varr[0], isCloud: varr[1].isCloud, varName: varr[1].name, isLocal: false })] = true;
        });

        oldEWU();

    // set animation
    // Blockly.getMainWorkspace().getAllBlocks().forEach(block=>{block.getSvgRoot().style.transition='transform 0.5s';})
    };

    //////////////////////////////// load-costume copied (modified to remove dependencies) from https://github.com/LLK/scratch-vm/blob/develop/src/import/load-costume.js //////////////////////////////////

    let BL_load_costume = {};
    {
        const canvasPool = (function () {
            /**
     * A pool of canvas objects that can be reused to reduce memory
     * allocations. And time spent in those allocations and the later garbage
     * collection.
     */
            class CanvasPool {
                constructor () {
                    this.pool = [];
                    this.clearSoon = null;
                }

                /**
         * After a short wait period clear the pool to let the VM collect
         * garbage.
         */
                clear () {
                    if (!this.clearSoon) {
                        this.clearSoon = new Promise(resolve => setTimeout(resolve, 1000))
                            .then(() => {
                                this.pool.length = 0;
                                this.clearSoon = null;
                            });
                    }
                }

                /**
         * Return a canvas. Create the canvas if the pool is empty.
         * @returns {HTMLCanvasElement} A canvas element.
         */
                create () {
                    return this.pool.pop() || document.createElement('canvas');
                }

                /**
         * Release the canvas to be reused.
         * @param {HTMLCanvasElement} canvas A canvas element.
         */
                release (canvas) {
                    this.clear();
                    this.pool.push(canvas);
                }
            }

            return new CanvasPool();
        }());

        /**
 * Return a promise to fetch a bitmap from storage and return it as a canvas
 * If the costume has bitmapResolution 1, it will be converted to bitmapResolution 2 here (the standard for Scratch 3)
 * If the costume has a text layer asset, which is a text part from Scratch 1.4, then this function
 * will merge the two image assets. See the issue LLK/scratch-vm#672 for more information.
 * @param {!object} costume - the Scratch costume object.
 * @param {!Runtime} runtime - Scratch runtime, used to access the v2BitmapAdapter
 * @param {?object} rotationCenter - optionally passed in coordinates for the center of rotation for the image. If
 *     none is given, the rotation center of the costume will be set to the middle of the costume later on.
 * @property {number} costume.bitmapResolution - the resolution scale for a bitmap costume.
 * @returns {?Promise} - a promise which will resolve to an object {canvas, rotationCenter, assetMatchesBase},
 *     or reject on error.
 *     assetMatchesBase is true if the asset matches the base layer; false if it required adjustment
 */
        const fetchBitmapCanvas_ = function (costume, runtime, rotationCenter) {
            if (!costume || !costume.asset) { // TODO: We can probably remove this check...
                return Promise.reject('Costume load failed. Assets were missing.');
            }
            if (!runtime.v2BitmapAdapter) {
                return Promise.reject('No V2 Bitmap adapter present.');
            }

            return Promise.all([costume.asset, costume.textLayerAsset].map(asset => {
                if (!asset) {
                    return null;
                }

                if (typeof createImageBitmap !== 'undefined') {
                    return createImageBitmap(
                        new Blob([asset.data], { type: asset.assetType.contentType }),
                    );
                }

                return new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = function () {
                        resolve(image);
                        image.onload = null;
                        image.onerror = null;
                    };
                    image.onerror = function () {
                        reject('Costume load failed. Asset could not be read.');
                        image.onload = null;
                        image.onerror = null;
                    };
                    image.src = asset.encodeDataURI();
                });
            }))
                .then(([baseImageElement, textImageElement]) => {
                    const mergeCanvas = canvasPool.create();

                    const scale = costume.bitmapResolution === 1 ? 2 : 1;
                    mergeCanvas.width = baseImageElement.width;
                    mergeCanvas.height = baseImageElement.height;

                    const ctx = mergeCanvas.getContext('2d');
                    ctx.drawImage(baseImageElement, 0, 0);
                    if (textImageElement) {
                        ctx.drawImage(textImageElement, 0, 0);
                    }
                    // Track the canvas we merged the bitmaps onto separately from the
                    // canvas that we receive from resize if scale is not 1. We know
                    // resize treats mergeCanvas as read only data. We don't know when
                    // resize may use or modify the canvas. So we'll only release the
                    // mergeCanvas back into the canvas pool. Reusing the canvas from
                    // resize may cause errors.
                    let canvas = mergeCanvas;
                    if (scale !== 1) {
                        canvas = runtime.v2BitmapAdapter.resize(mergeCanvas, canvas.width * scale, canvas.height * scale);
                    }

                    // By scaling, we've converted it to bitmap resolution 2
                    if (rotationCenter) {
                        rotationCenter[0] = rotationCenter[0] * scale;
                        rotationCenter[1] = rotationCenter[1] * scale;
                        costume.rotationCenterX = rotationCenter[0];
                        costume.rotationCenterY = rotationCenter[1];
                    }
                    costume.bitmapResolution = 2;

                    // Clean up the costume object
                    delete costume.textLayerMD5;
                    delete costume.textLayerAsset;

                    return {
                        canvas,
                        mergeCanvas,
                        rotationCenter,
                        // True if the asset matches the base layer; false if it required adjustment
                        assetMatchesBase: scale === 1 && !textImageElement,
                    };
                })
                .finally(() => {
                    // Clean up the text layer properties if it fails to load
                    delete costume.textLayerMD5;
                    delete costume.textLayerAsset;
                });
        };

        const loadBitmap_ = function (costume, runtime, _rotationCenter) {
            return fetchBitmapCanvas_(costume, runtime, _rotationCenter)
                .then(fetched => {
                    const updateCostumeAsset = function (dataURI) {
                        if (!runtime.v2BitmapAdapter) {
                            // TODO: This might be a bad practice since the returned
                            // promise isn't acted on. If this is something we should be
                            // creating a rejected promise for we should also catch it
                            // somewhere and act on that error (like logging).
                            //
                            // Return a rejection to stop executing updateCostumeAsset.
                            return Promise.reject('No V2 Bitmap adapter present.');
                        }

                        const storage = runtime.storage;
                        costume.asset = storage.createAsset(
                            storage.AssetType.ImageBitmap,
                            storage.DataFormat.PNG,
                            runtime.v2BitmapAdapter.convertDataURIToBinary(dataURI),
                            null,
                            true, // generate md5
                        );
                        costume.dataFormat = storage.DataFormat.PNG;
                        costume.assetId = costume.asset.assetId;
                        costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
                    };

                    if (!fetched.assetMatchesBase) {
                        updateCostumeAsset(fetched.canvas.toDataURL());
                    }

                    return fetched;
                })
                .then(({ canvas, mergeCanvas, rotationCenter }) => {
                    // createBitmapSkin does the right thing if costume.rotationCenter is undefined.
                    // That will be the case if you upload a bitmap asset or create one by taking a photo.
                    let center;
                    if (rotationCenter) {
                        // fetchBitmapCanvas will ensure that the costume's bitmap resolution is 2 and its rotation center is
                        // scaled to match, so it's okay to always divide by 2.
                        center = [
                            rotationCenter[0] / 2,
                            rotationCenter[1] / 2,
                        ];
                    }

                    // TODO: costume.bitmapResolution will always be 2 at this point because of fetchBitmapCanvas_, so we don't
                    // need to pass it in here.
                    costume.skinId = runtime.renderer.createBitmapSkin(canvas, costume.bitmapResolution, center);
                    canvasPool.release(mergeCanvas);
                    const renderSize = runtime.renderer.getSkinSize(costume.skinId);
                    costume.size = [renderSize[0] * 2, renderSize[1] * 2]; // Actual size, since all bitmaps are resolution 2

                    if (!rotationCenter) {
                        rotationCenter = runtime.renderer.getSkinRotationCenter(costume.skinId);
                        // Actual rotation center, since all bitmaps are resolution 2
                        costume.rotationCenterX = rotationCenter[0] * 2;
                        costume.rotationCenterY = rotationCenter[1] * 2;
                        costume.bitmapResolution = 2;
                    }
                    return costume;
                });
        };

        // Handle all manner of costume errors with a Gray Question Mark (default costume)
        // and preserve as much of the original costume data as possible
        // Returns a promise of a costume
        const handleCostumeLoadError = function (costume, runtime) {
            // Keep track of the old asset information until we're done loading the default costume
            const oldAsset = costume.asset; // could be null
            const oldAssetId = costume.assetId;
            const oldRotationX = costume.rotationCenterX;
            const oldRotationY = costume.rotationCenterY;
            const oldBitmapResolution = costume.bitmapResolution;
            const oldDataFormat = costume.dataFormat;

            const AssetType = runtime.storage.AssetType;
            const isVector = costume.dataFormat === AssetType.ImageVector.runtimeFormat;

            // Use default asset if original fails to load
            costume.assetId = isVector ?
                runtime.storage.defaultAssetId.ImageVector :
                runtime.storage.defaultAssetId.ImageBitmap;
            costume.asset = runtime.storage.get(costume.assetId);
            costume.md5 = `${costume.assetId}.${costume.asset.dataFormat}`;

            const defaultCostumePromise = (isVector) ?
                loadVector_(costume, runtime) : loadBitmap_(costume, runtime);

            return defaultCostumePromise.then(loadedCostume => {
                loadedCostume.broken = {};
                loadedCostume.broken.assetId = oldAssetId;
                loadedCostume.broken.md5 = `${oldAssetId}.${oldDataFormat}`;

                // Should be null if we got here because the costume was missing
                loadedCostume.broken.asset = oldAsset;
                loadedCostume.broken.dataFormat = oldDataFormat;

                loadedCostume.broken.rotationCenterX = oldRotationX;
                loadedCostume.broken.rotationCenterY = oldRotationY;
                loadedCostume.broken.bitmapResolution = oldBitmapResolution;
                return loadedCostume;
            });
        };

        /**
 * Initialize a costume from an asset asynchronously.
 * Do not call this unless there is a renderer attached.
 * @param {!object} costume - the Scratch costume object.
 * @property {int} skinId - the ID of the costume's render skin, once installed.
 * @property {number} rotationCenterX - the X component of the costume's origin.
 * @property {number} rotationCenterY - the Y component of the costume's origin.
 * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
 * @property {!Asset} costume.asset - the asset of the costume loaded from storage.
 * @param {!Runtime} runtime - Scratch runtime, used to access the storage module.
 * @param {?int} optVersion - Version of Scratch that the costume comes from. If this is set
 *     to 2, scratch 3 will perform an upgrade step to handle quirks in SVGs from Scratch 2.0.
 * @returns {?Promise} - a promise which will resolve after skinId is set, or null on error.
 */
        const loadCostumeFromAsset = function (costume, runtime, optVersion) {
            costume.assetId = costume.asset.assetId;
            const renderer = runtime.renderer;
            if (!renderer) {
                log.warn('No rendering module present; cannot load costume: ', costume.name);
                return Promise.resolve(costume);
            }
            const AssetType = runtime.storage.AssetType;
            let rotationCenter;
            // Use provided rotation center and resolution if they are defined. Bitmap resolution
            // should only ever be 1 or 2.
            if (typeof costume.rotationCenterX === 'number' && !isNaN(costume.rotationCenterX) &&
            typeof costume.rotationCenterY === 'number' && !isNaN(costume.rotationCenterY)) {
                rotationCenter = [costume.rotationCenterX, costume.rotationCenterY];
            }
            return loadBitmap_(costume, runtime, rotationCenter, optVersion)
                .catch(error => {
                    log.warn(`Error loading bitmap image: ${error}`);
                    return handleCostumeLoadError(costume, runtime);
                });
        };


        /**
 * Load a costume's asset into memory asynchronously.
 * Do not call this unless there is a renderer attached.
 * @param {!string} md5ext - the MD5 and extension of the costume to be loaded.
 * @param {!object} costume - the Scratch costume object.
 * @property {int} skinId - the ID of the costume's render skin, once installed.
 * @property {number} rotationCenterX - the X component of the costume's origin.
 * @property {number} rotationCenterY - the Y component of the costume's origin.
 * @property {number} [bitmapResolution] - the resolution scale for a bitmap costume.
 * @param {!Runtime} runtime - Scratch runtime, used to access the storage module.
 * @param {?int} optVersion - Version of Scratch that the costume comes from. If this is set
 *     to 2, scratch 3 will perform an upgrade step to handle quirks in SVGs from Scratch 2.0.
 * @returns {?Promise} - a promise which will resolve after skinId is set, or null on error.
 */
        const loadCostume = function (md5ext, costume, runtime, optVersion) {
            const idParts = md5ext.split('.');
            const md5 = idParts[0];
            const ext = idParts[1].toLowerCase();
            costume.dataFormat = ext;

            if (costume.asset) {
                // Costume comes with asset. It could be coming from image upload, drag and drop, or file
                return loadCostumeFromAsset(costume, runtime, optVersion);
            }

            // Need to load the costume from storage. The server should have a reference to this md5.
            if (!runtime.storage) {
                log.warn('No storage module present; cannot load costume asset: ', md5ext);
                return Promise.resolve(costume);
            }

            if (!runtime.storage.defaultAssetId) {
                log.warn('No default assets found');
                return Promise.resolve(costume);
            }

            const AssetType = runtime.storage.AssetType;
            const assetType = (ext === 'svg') ? AssetType.ImageVector : AssetType.ImageBitmap;

            const costumePromise = runtime.storage.load(assetType, md5, ext);

            let textLayerPromise;
            if (costume.textLayerMD5) {
                textLayerPromise = runtime.storage.load(AssetType.ImageBitmap, costume.textLayerMD5, 'png');
            } else {
                textLayerPromise = Promise.resolve(null);
            }

            return Promise.all([costumePromise, textLayerPromise])
                .then(assetArray => {
                    if (assetArray[0]) {
                        costume.asset = assetArray[0];
                    } else {
                        return handleCostumeLoadError(costume, runtime);
                    }

                    if (assetArray[1]) {
                        costume.textLayerAsset = assetArray[1];
                    }
                    return loadCostumeFromAsset(costume, runtime, optVersion);
                })
                .catch(error => {
                    // Handle case where storage.load rejects with errors
                    // instead of resolving null
                    log.warn('Error loading costume: ', error);
                    return handleCostumeLoadError(costume, runtime);
                });
        };
        BL_load_costume = {
            loadCostume,
            loadCostumeFromAsset,
        };
    };
    //////////////////////////////////////////// end load-costume //////////////////////////////////////////////

    // vm.editingTarget = a;
    // vm.emitTargetsUpdate(false /* Don't emit project change */);
    // vm.emitWorkspaceUpdate();
    // vm.blockListener = proxy(vm.blockListener,"blocks",
    //     (args)=>({type:args[0].type}),
    //     (data)=>[{...data.args[0],type:data.extrargs.type}]
    // )
    // vm.blockListener = stProxy(vm.blockListener,"blocklist",null,null,null,()=>{vm.emitWorkspaceUpdate()})


    // TODO: eventually maybe sync this
    // vm.runtime.requestShowMonitor = anyproxy(vm.runtime,vm.runtime.requestShowMonitor,"showmonitor")
    // vm.runtime.requestHideMonitor = anyproxy(vm.runtime,vm.runtime.requestHideMonitor,"showmonitor")


    //sounds


    vm.updateSoundBuffer = asyncEditingProxy(vm.updateSoundBuffer, 'updatesound', null, null, (args) => {
        const extrargs = {};
        return extrargs;
    }, async (data) => {
        const retArgs = data.args;
        retArgs[2] = Uint8Array.from(Object.values(retArgs[2]));
        // WOW im proud of this one! Create an AudioBuffer from Uint8Array
        retArgs[1] = await (new AudioContext({ sampleRate: retArgs[1].sampleRate })).decodeAudioData(retArgs[2].buffer.slice(0));
        // Wait no that requires async programming which i dont have here ugggggg
        // Keep the variable reporter aligned with the current monitor value.
        return retArgs;
    });


    vm.addSound = proxy(vm.addSound, 'addsound',
        (args) => {
            let targetName;
            if (!!args[1]) { targetName = targetToName(vm.runtime.getTargetById(args[1])); } else { targetName = targetToName(vm.editingTarget); }
            return { target: targetName };
        },
        (data) => {
            const ret = [data.args[0], nameToTarget(data.extrargs.target)?.id];
            if (ret[0]?.asset?.data) {
            // adapted from scratch source 'file-uploader'
                ret[0].asset = vm.runtime.storage.createAsset(
                    ret[0].asset.assetType,
                    ret[0].asset.dataFormat,
                    Uint8Array.from(Object.values(ret[0].asset.data)), null, true);
                ret[0] = {
                    name: ret[0].name,
                    dataFormat: ret[0].asset.dataFormat,
                    asset: ret[0].asset,
                    md5: `${ret[0].asset.assetId}.${ret[0].asset.dataFormat}`,
                    assetId: ret[0].asset.assetId,
                };
            }
            return ret;
        },
    );





    vm.duplicateSound = editingProxy(vm.duplicateSound, 'duplicatesound');
    vm.deleteSound = editingProxy(vm.deleteSound, 'deletesound');
    vm.renameSound = editingProxy(vm.renameSound, 'renamesound');
    vm.shareSoundToTarget = editingProxy(vm.shareSoundToTarget, 'sharesound');
    vm.reorderSound = proxy(vm.reorderSound, 'reordersound',
        (args) => ({ target: targetToName(vm.runtime.getTargetById(args[0])) }),
        (data) => [nameToTarget(data.extrargs.target).id, data.args[1], data.args[2]], null);

    // costumes
    vm.renameCostume = editingProxy(vm.renameCostume, 'renamecostume');
    vm.duplicateCostume = editingProxy(vm.duplicateCostume, 'dupecostume');
    vm.deleteCostume = editingProxy(vm.deleteCostume, 'deletecostume');
    vm.reorderCostume = proxy(vm.reorderCostume, 'reordercostume',
        (args) => ({ target: targetToName(vm.runtime.getTargetById(args[0])) }),
        (data) => [nameToTarget(data.extrargs.target).id, data.args[1], data.args[2]], null,
        () => { vm.emitTargetsUpdate(); });
    vm.shareCostumeToTarget = editingProxy(vm.shareCostumeToTarget, 'sharecostume', null, null, (args) => ({
        targettarget: BL_UTILS.targetToName(vm.runtime.getTargetById(args[1])),
    }), (data) => ([data.args[0], BL_UTILS.nameToTarget(data.extrargs.targettarget)?.id]));
    vm.addCostume = proxy(vm.addCostume, 'addcostume',
        (args) => {
            let targetName;
            if (!!args[2]) { targetName = targetToName(vm.runtime.getTargetById(args[2])); } else { targetName = targetToName(vm.editingTarget); }
            return { target: targetName };
        },
        (data) => {
            const ret = [data.args[0], data.args[1], nameToTarget(data.extrargs.target)?.id, data.args[3]];
            if (ret[1]?.asset?.data) {
            // adapted from scratch source 'file-uploader'
                ret[1].asset = vm.runtime.storage.createAsset(
                    ret[1].asset.assetType,
                    ret[1].asset.dataFormat,
                    Uint8Array.from(Object.values(ret[1].asset.data)), null, true);
                ret[1] = {
                    name: null,
                    dataFormat: ret[1].asset.dataFormat,
                    asset: ret[1].asset,
                    md5: `${ret[1].asset.assetId}.${ret[1].asset.dataFormat}`,
                    assetId: ret[1].asset.assetId,
                };
            }
            return ret;
        },
    );

    vm.addBackdrop = proxy(vm.addBackdrop, 'addbackdrop',
        null,
        (data) => {
            const ret = [data.args[0], data.args[1]];
            if (ret[1]?.asset?.data) {
            // adapted from scratch source 'file-uploader'
                ret[1].asset = vm.runtime.storage.createAsset(
                    ret[1].asset.assetType,
                    ret[1].asset.dataFormat,
                    Uint8Array.from(Object.values(ret[1].asset.data)), null, true);
                ret[1] = {
                    name: null,
                    dataFormat: ret[1].asset.dataFormat,
                    asset: ret[1].asset,
                    md5: `${ret[1].asset.assetId}.${ret[1].asset.dataFormat}`,
                    assetId: ret[1].asset.assetId,
                };
            }
            return ret;
        },
    );
    // vm.updateBitmap = editingProxy(vm.updateBitmap,"updatebitmap",null,(_a,_b,data)=>{
    //     let costumeIndex = getSelectedCostumeIndex()
    //     // update paint editor if reciever is editing the costume
    //     if(targetToName(vm.editingTarget) === data.extrargs.target && costumeIndex !== -1 && costumeIndex === data.args[0]) {
    //         // todo use some other method of refreshing the canvas
    //         document.getElementById('react-tabs-4').click()
    //         document.getElementById('react-tabs-2').click()
    //     }
    // },
    //     (args)=>({height:args[1].height,width:args[1].width}),
    //     (data)=>{
    //         let args = data.args;
    //         args[1] = new ImageData(Uint8ClampedArray.from(Object.values(args[1].data)), data.extrargs.width, data.extrargs.height);
    //         return args
    //     })
    // vm.updateSvg = editingProxy(vm.updateSvg,"updatesvg",null,(_a,_b,data)=>{
    //     let costumeIndex = getSelectedCostumeIndex()
    //     // update paint editor if reciever is editing the costume
    //     // todo: instead of checking with vm.editingTarget, use _a or _b
    //     if(targetToName(_a) === data.extrargs.target && costumeIndex !== -1 && costumeIndex === data.args[0]) {
    //         let costume = vm.editingTarget.getCostumes()[costumeIndex]
    //         let paper = getPaper()
    //         if(!paper) {return;}
    //         paper.switchCostume(
    //             costume.dataFormat,
    //             costume.asset.decodeText(),
    //             costume.rotationCenterX,
    //             costume.rotationCenterY,
    //             paper.props.zoomLevelId,
    //             paper.props.zoomLevelId)
    //     }
    // })
    const oldUpdateBitmap = vm.updateBitmap;
    vm.updateBitmap = (...args) => {
    // args: costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution
        oldUpdateBitmap.bind(vm)(...args);
        // vm runs emitTargetsUpdate after creating new asset
        etuListeners.push(async() => {
            const target = BL_UTILS.targetToName(vm.editingTarget);

            const costumeIndex = args[0];
            const bitmapResolution = args[4];
            const costume = vm.editingTarget.getCostumes()[costumeIndex];
            const sendCostume = JSON.parse(JSON.stringify(costume));
            delete sendCostume.asset;
            const asset = costume.asset;

            const bitmap = args[1];
            const w = bitmap.sourceWidth === 0 ? 0 : bitmap.width;
            const h = bitmap.sourceHeight === 0 ? 0 : bitmap.height;

            // send costume to scratch servers
            const stored = await vm.runtime.storage.store(asset.assetType, asset.dataFormat, asset.data, asset.assetId);
            // get costume info to send

            liveMessage({ meta: 'vm.updateBitmap', costume: sendCostume, target, costumeIndex, assetType: asset.assetType, h, w, bitmapResolution });
        });
    };
    async function updateBitmap(msg) {
        const target = BL_UTILS.nameToTarget(msg.target);
        const costume = target.getCostumes()[msg.costumeIndex];
        asset = await vm.runtime.storage.load(msg.assetType, msg.costume.assetId, msg.costume.dataFormat);

        costume.asset = asset;
        Object.entries(msg.costume).forEach(entry => {
            costume[entry[0]] = entry[1];
        },
        );

        vm.emitTargetsUpdate();

        // update paper
        const selectedCostumeIndex = getSelectedCostumeIndex();
        if (BL_UTILS.targetToName(vm.editingTarget) === msg.target && selectedCostumeIndex !== -1 && msg.costumeIndex === selectedCostumeIndex) {
            const costume = vm.editingTarget.getCostumes()[msg.costumeIndex];
            const paper = getPaper();
            if (!paper) { return; }
            paper.switchCostume(
                costume.dataFormat,
                costume.asset.encodeDataURI(),
                costume.rotationCenterX,
                costume.rotationCenterY,
                paper.props.zoomLevelId,
                paper.props.zoomLevelId);
        }

        // update renderer costume skins [VERY IMPORTANT FOR RENDER!]
        await BL_load_costume.loadCostume(costume.md5, costume, vm.runtime);
        target.updateAllDrawableProperties();

        // image = new ImageData(new Uint8ClampedArray(asset.data.buffer),msg.w,msg.h)

        /// TODO GET BITMAP SHOWING UP IN RENDER
        // const tmpCanvas = document.createElement('canvas');
        // tmpCanvas.width = msg.w;
        // tmpCanvas.height = msg.h;
        // const tmpCtx = tmpCanvas.getContext('2d');
        // const imageData = tmpCtx.createImageData(msg.w, msg.h);
        // imageData.data.set(asset.data);
        // tmpCtx.putImageData(imageData, 0, 0);

    // vm.runtime.renderer.updateBitmapSkin(
    //     costume.skinId,
    //     tmpCanvas,
    //     msg.bitmapResolution,
    //     [costume.rotationCenterX / msg.bitmapResolution, costume.rotationCenterY / msg.bitmapResolution]
    // );
    }









    const oldUpdateSvg = vm.updateSvg;
    vm.updateSvg = (...args) => {

        // args: costumeIndex, bitmap, rotationCenterX, rotationCenterY, bitmapResolution
        oldUpdateSvg.bind(vm)(...args);

        // vm runs emitTargetsUpdate after creating new asset
        { (async() => {
            const target = BL_UTILS.targetToName(vm.editingTarget);

            const costumeIndex = args[0];
            const costume = vm.editingTarget.getCostumes()[costumeIndex];
            const sendCostume = JSON.parse(JSON.stringify(costume));
            delete sendCostume.asset;
            const asset = costume.asset;

            // send costume to scratch servers
            const stored = await vm.runtime.storage.store(asset.assetType, asset.dataFormat, asset.data, asset.assetId);
            // get costume info to send

            liveMessage({ meta: 'vm.updateSvg', costume: sendCostume, target, costumeIndex, assetType: asset.assetType });
        })(); }

    };
    async function updateSvg(msg) {
        const target = BL_UTILS.nameToTarget(msg.target);
        const costume = target.getCostumes()[msg.costumeIndex];
        asset = await vm.runtime.storage.load(msg.assetType, msg.costume.assetId, msg.costume.dataFormat);

        costume.asset = asset;
        Object.entries(msg.costume).forEach(entry => {
            if (entry[0] === 'skinId') { return; }
            costume[entry[0]] = entry[1];
        });

        vm.emitTargetsUpdate();

        // update skin
        if (vm?.runtime?.renderer) {
        // costume data to xml svg dom text
            const svg = new TextDecoder().decode(costume.asset.data);
            vm.runtime.renderer.updateSVGSkin(costume.skinId, svg, [costume.rotationCenterX, costume.rotationCenterY]);
        }

        // update paper
        const selectedCostumeIndex = getSelectedCostumeIndex();
        if (BL_UTILS.targetToName(vm.editingTarget) === msg.target && selectedCostumeIndex !== -1 && msg.costumeIndex === selectedCostumeIndex) {
            const costume = vm.editingTarget.getCostumes()[msg.costumeIndex];
            const paper = getPaper();
            if (!paper) { return; }
            paper.switchCostume(
                costume.dataFormat,
                costume.asset.encodeDataURI(),
                costume.rotationCenterX,
                costume.rotationCenterY,
                paper.props.zoomLevelId,
                paper.props.zoomLevelId);
        }

        // update renderer costume skins [VERY IMPORTANT FOR RENDER!]
        // await BL_load_costume.loadCostume(costume.md5,costume,vm.runtime)
        target.updateAllDrawableProperties();
    }










    // vm.updateBitmap = proxy(vm.updateBitmap,"updatebit",null,null,null,()=>{vm.emitTargetsUpdate();vm.emitWorkspaceUpdate()})
    // vm.updateSvg = proxy(vm.updateSvg,"updatesvg",null,null,null,()=>{vm.emitTargetsUpdate();vm.emitWorkspaceUpdate()})
    newTargetEvents = {}; // targetName => [events...] //todo make let statement
    function addNewTargetEvent(targetName, event) {
        if (!(targetName in newTargetEvents)) {
            newTargetEvents[targetName] = [];
        }
        newTargetEvents[targetName].push(event);
    }

    // ()=>{pauseEventHandling = true},(
    vm.addSprite = proxy(vm.addSprite, 'addsprite', (args) => {
        if (args[0] instanceof ArrayBuffer) {
            return { spritearray: Array.from(new Uint8Array(args[0])) };
        } else return {};
    }, (data) => (data.extrargs.spritearray ? [Uint8Array.from(data.extrargs.spritearray).buffer] : [...data.args]), null, (a, b) => { vm.setEditingTarget(a.id); });
    vm.duplicateSprite = proxy(vm.duplicateSprite, 'duplicatesprite',
    // extrargs
        (args) => ({ name: targetToName(vm.runtime.getTargetById(args[0])) }),
        (data) => [nameToTarget(data.extrargs.name)?.id],
        () => { pauseEventHandling = true; },
        ((a, b, n, result) => {
            vm.setEditingTarget(a.id);
            pauseEventHandling = false;
            newTargetEvents[b.sprite.name]?.forEach(event => collaborationListener(event));

        }), null, null, () => {
        // send replace blocks message
            liveMessage({ meta: 'vm.replaceBlocks', target: targetToName(vm.editingTarget), blocks: vm.editingTarget.blocks._blocks });
        });
    // Object.keys(vm.editingTarget.blocks._blocks).forEach(v=>{vm.editingTarget.blocks.deleteBlock(v)})
    vm.deleteSprite = proxy(vm.deleteSprite, 'deletesprite',
        (args) => ({ name: targetToName(vm.runtime.getTargetById(args[0])) }),
        (data) => [nameToTarget(data.extrargs.name).id]);
    vm.renameSprite = proxy(vm.renameSprite, 'renamesprite',
        (args) => ({ oldName: targetToName(vm.runtime.getTargetById(args[0])) }),
        (data) => [nameToTarget(data.extrargs.oldName).id, data.args[1]]);
    vm.reorderTarget = proxy(vm.reorderTarget, 'reordertarget');
    // vm.shareBlocksToTarget = proxy(vm.shareBlocksToTarget,"shareblocks",
    // (args)=>({toName:vm.runtime.getTargetById(args[1]).sprite.name}),
    // (data)=>[data.args[0],vm.runtime.getSpriteTargetByName(data.extrargs.toName).id],null,()=>{vm.emitWorkspaceUpdate()})
    const oldVmSetCloudProvider = vm.setCloudProvider.bind(vm);
    vm.setCloudProvider = function(that) {
        if (!store?.getState()?.preview.projectInfo.is_published && !!that) {
            that.projectId = lsId;
        }
        oldVmSetCloudProvider(that);
    };
    function connectToCoBlocksCloud() {
        if (!lsId) { return; }
        vm.runtime.ioDevices.cloud.provider.projectId = lsId;
        vm.runtime.ioDevices.cloud.provider.openConnection();
    }

    let shareCreates = [];
    let lastDeletedBlock;
    waitFor(() => (vm.editingTarget)).then(() => {
        const oldCreateBlock = vm.editingTarget.blocks.__proto__.createBlock;

        vm.editingTarget.blocks.__proto__.createBlock = function(...args) {
            if (isTargetSharing) {
                shareCreates.push(args);
            }
            return oldCreateBlock.call(this, ...args);
        };

        const oldDeleteBlock = vm.editingTarget.blocks.__proto__.deleteBlock;
        vm.editingTarget.blocks.__proto__.deleteBlock = function(...args) {
            lastDeletedBlock = this._blocks[args[0]];
            return oldDeleteBlock.call(this, ...args);
        };
    });

    waitFor(() => (vm.extensionManager)).then(() => {
        vm.extensionManager.loadExtensionURL =
    anyproxy(vm.extensionManager, vm.extensionManager.loadExtensionURL, 'loadextensionurl');
    });


    const oldShareBlocksToTarget = vm.shareBlocksToTarget;
    let isTargetSharing = false;
    vm.shareBlocksToTarget = function(blocks, targetId, optFromTargetId) {
        shareCreates = [];
        isTargetSharing = true;
        return oldShareBlocksToTarget.bind(vm)(blocks, targetId, optFromTargetId).then(() => {
            isTargetSharing = false;
            const targetName = targetToName(vm.runtime.getTargetById(targetId));
            const fromTargetName = targetToName(vm.runtime.getTargetById(optFromTargetId));
            liveMessage({ meta: 'vm.shareBlocks', target: targetName, from: fromTargetName, blocks: shareCreates });
        });
    };

    function doShareBlocksMessage(msg) {
        const target = nameToTarget(msg.target);
        const targetId = target.id;
        const fromTargetId = nameToTarget(msg.from)?.id;
        // resolve variable conflicts
        // if(!!fromTargetId) {vm.runtime.getTargetById(fromTargetId).resolveVariableSharingConflictsWithTarget(msg.blocks, target);}

        // create new blocks in target
        msg.blocks.forEach(bargs => { target.blocks.createBlock(...bargs); });
        target.blocks.updateTargetSpecificBlocks(target.isStage);

        if (targetId === vm.editingTarget.id) { vm.emitWorkspaceUpdate(); }
        // update flyout for new variables and blocks
        if (!isWorkspaceAccessable()) { return; }
        getWorkspace().getToolbox().refreshSelection();
    }



    // no sure what this does but it might be useful at some point this.editingTarget.fixUpVariableReferences();

    // port.postMessage();

    function postCursorPosition() {
        const workspace = getWorkspace();
        if (!workspace) { return; }
        const scrollX = workspace.scrollX;
        const scrollY = workspace.scrollY;
        const scale = workspace.scale;
        const targetName = BL_UTILS.targetToName(vm.editingTarget);
        const editorTab = store?.getState()?.scratchGui?.editorTab?.activeTabIndex;
        const cursor = { scrollX, scrollY, scale, targetName, editorTab };
        liveMessage({ type: 'setCursor', cursor });
    }
    setInterval(postCursorPosition, 2500);


}



function createTagElement(username, color) {
    document.querySelector('rect.blockly-name-tag')?.remove();
    document.querySelector('text.blockly-name-tag')?.remove();
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.style.fontFamily = '"Helvetica Neue", Helvetica, Arial, sans-serif';
    text.setAttribute('fill', 'white');
    text.style.fontSize = '1.25rem';
    text.style.transform = 'translate(.5rem, -1rem)';
    let newUsername = username;
    if (username.length > 12) {
        newUsername = username.slice(0, 12) + '...';
    }
    text.textContent = newUsername;
    text.classList.add('blockly-name-tag');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '12rem');
    rect.setAttribute('height', '2rem');
    rect.setAttribute('rx', '.5rem');
    rect.classList.add('blockly-name-tag');
    rect.style.transform = 'translate(0rem, -2.2rem)';
    rect.setAttribute('fill', '#58c198');
    return [text, rect];
}

function setTag(tag, state) {
    if (state) {
        tag.classList.remove('turnOff');
        tag.classList.add('turnOn');
    } else {
        tag.classList.remove('turnOn');
        tag.classList.add('turnOff');
    }
}
function setOutline(blocks, state) {
    if (state) {
        blocks.classList.remove('turnOff');
        blocks.classList.remove('turnedOff');
        blocks.classList.add('blocRect', 'turnOn');
    } else {
        blocks.classList.remove('turnOn');
        blocks.classList.remove('turnedOn');
        blocks.classList.add('blocRect', 'turnOff');
    }
    const animation = blocks.getAnimations().find(anim => anim.animationName?.includes('outline'));
    animation.addEventListener('finish', () => {
        if (state) {
            blocks.classList.remove('turnOn');
            blocks.classList.add('turnedOn');
        } else {
            blocks.classList.remove('turnOff');
            blocks.classList.add('turnedOff');
        }
    });
}

function selectBlock(blocks, username, state, color) {
    blocks.style.outlineColor = color;
    let tag = blocks.querySelector('g' + '.tag');
    // let tag = blocks.querySelector(username + '.tag')
    if (!tag) {
        tag = createTagElement(username, color);
        blocks.appendChild(tag[1]);
        blocks.appendChild(tag[0]);
    }
    setOutline(blocks, state, color);
    setTag(tag[1], state, color);
    setTag(tag[0], state, color);
}


BL_BlockOutlinesUsers = {}; // {username: {blockid?,styles:{}}}
BL_BlockTimeouts = {}; // {blockid:timeoutid}
BL_BlockOutlinesBlocks = {}; // {blockid:def}

function resetBlock(outlineObj, username) {
    const block = Blockly.getMainWorkspace().getBlockById(outlineObj.blockId)
        ?? Blockly.getMainWorkspace().getCommentById(outlineObj.blockId);
    if (!block) { return; }
    const element = block.getSvgRoot();
    element.style.transition = 'all 0.5s';
    selectBlock(element, username, false);
}
function setBlockStyles(blockId, blockElem, newStyles, username) {
    const styles = {};
    blockElem.style.transition = 'transform 0.5s';
    selectBlock(blockElem, username, true, '#58c198');
    return { blockId, styles };
}



function outlineBlock(blockId, username) {
    if (blockId in BL_BlockOutlinesBlocks) {
        resetBlock(BL_BlockOutlinesBlocks[blockId], username);
        delete BL_BlockOutlinesBlocks[blockId];
        clearTimeout(BL_BlockTimeouts[blockId]);
        delete BL_BlockTimeouts[blockId];
    }
    if (username in BL_BlockOutlinesUsers) {
        resetBlock(BL_BlockOutlinesUsers[username], username);
        delete BL_BlockOutlinesUsers[username];
    }
    const workspace = Blockly.getMainWorkspace();
    if (!workspace) { return; }
    const block = workspace.getBlockById(blockId) ?? workspace.getCommentById(blockId);
    if (!block) { return; }

    const blockElem = block.getSvgRoot();

    const blockResetDef = setBlockStyles(blockId, blockElem,
        { 'outline': 'solid 8px #ffc83d' }, username,
    );
    BL_BlockOutlinesUsers[username] = blockResetDef;
    BL_BlockOutlinesBlocks[blockId] = blockResetDef;

    const timeoutId = setTimeout(() => { resetBlock(blockResetDef, username); }, 2500); // clear outline in 5 seconds
    BL_BlockTimeouts[blockId] = timeoutId;
}










/////........................ GUI INJECTS .........................//////
const shareDropdown = `
<div class="ls-collab-panel" role="dialog" aria-label="CoBlocks collaboration">
    <div class="ls-collab-header">
        <div class="ls-collab-brand"><img src="${logoUrl}" alt=""></div>
        <div class="ls-collab-heading">
            <strong>Collaboration</strong>
            <span>Manage this CoBlocks project</span>
        </div>
        <button class="ls-icon-button" type="button" aria-label="Close" onclick="lsDropdown.style.display='none';coblocksButton.setAttribute('aria-expanded','false')">&times;</button>
    </div>
    <div class="ls-collab-stats" aria-live="polite">
        <span><strong id="lsCollabCount">0</strong> <span id="lsPeopleLabel">people</span></span>
        <span><i class="ls-online-dot"></i><strong id="lsOnlineCount">0</strong> online</span>
    </div>
    <div class="ls-section-heading">
        <div><strong>Project access</strong><span>People who can edit with you</span></div>
        <button class="ls-text-button" type="button" onclick="refreshShareModal(true)">Refresh</button>
    </div>
    <div id="lsSharedList" class="ls-shared-list">
        <div id="lsModalExample" class="ls-collab-member" hidden>
            <span class="ls-member-avatar"><i class="ls-member-presence"></i></span>
            <button class="sharedName ls-member-name" type="button"></button>
            <span class="ls-member-role">Collaborator</span>
            <button class="ls-remove-collaborator" type="button" aria-label="Remove collaborator">&times;</button>
        </div>
        <div id="lsEmptyCollaborators" class="ls-empty-state">No collaborators yet</div>
    </div>
    <div class="ls-divider"></div>
    <label class="ls-add-label" for="searchy"><strong>Add a collaborator</strong><span>Enter their exact Scratch username</span></label>
    <div class="ls-search-wrap">
        <input id="searchy" type="search" autocomplete="off" spellcheck="false" placeholder="Scratch username" aria-label="Scratch username">
        <span id="lsSearchSpinner" class="ls-mini-spinner" hidden></span>
    </div>
    <button class="result ls-search-result" type="button" id="resultt" hidden>
        <span id="resultPic" class="ls-result-avatar"></span>
        <span class="ls-result-copy"><strong id="resultName"></strong><small>Click to add</small></span>
        <span id="plus" class="ls-result-add">+</span>
    </button>
    <div id="lsShareStatus" class="ls-share-status" role="status" aria-live="polite"></div>
    <div class="ls-collab-actions">
        <button type="button" class="ls-secondary-button" onclick="copyCollaborationInvite()">Copy invite link</button>
        <button type="button" class="ls-secondary-button" onclick="revokeCollaborationInvite()">Revoke invite</button>
        <button type="button" class="ls-danger-button" onclick="unlinkCoBlocks()">Unlink project</button>
    </div>
</div>

`;
const shareScript = `{
window.lsSearchName = document.querySelector('#resultName');
window.lsSearchResult = document.querySelector('#resultt');
window.lsSearchAvatar = document.querySelector('#resultPic');
window.lsCollaboratorTemplate = document.querySelector('#lsModalExample');
window.lsSearchInput = document.querySelector('#searchy');
window.lsShareMembers = {};
let searchTimer;
let searchSequence = 0;

lsSearchResult.addEventListener('click', () => addCollaborator(lsSearchResult.username));
lsSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (lsSearchResult.username && !lsSearchResult.hidden) addCollaborator(lsSearchResult.username);
    }
});

lsSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = lsSearchInput.value.trim();
    const sequence = ++searchSequence;
    lsSearchResult.hidden = true;
    lsSearchResult.username = '';
    document.querySelector('#lsSearchSpinner').hidden = query.length < 2;
    if (query.length < 2) return;
    searchTimer = setTimeout(async () => {
        try {
            const user = await getUserInfo(query);
            if (sequence !== searchSequence || query.toLowerCase() !== lsSearchInput.value.trim().toLowerCase()) return;
            document.querySelector('#lsSearchSpinner').hidden = true;
            if (!user) {
                setShareStatus('No Scratch user found.', 'error');
                return;
            }
            setShareStatus('');
            lsSearchName.innerText = user.username;
            lsSearchResult.username = user.username;
            lsSearchAvatar.style.backgroundImage = \`url('\${user.pic}')\`;
            lsSearchResult.hidden = false;
        } catch (error) {
            document.querySelector('#lsSearchSpinner').hidden = true;
            setShareStatus('Could not search Scratch right now.', 'error');
        }
    }, 350);
});
}
`;
const shareCSS = `
.ls-collab-panel, .ls-collab-panel * { box-sizing: border-box; }
.ls-collab-panel {
    width: min(320px, calc(100vw - 24px)); min-width: 0; max-width: 320px; max-height: calc(100vh - 72px); display: flex; flex-direction: column; gap: 12px; padding: 16px;
    overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
    color: #14264d; background: #fff; border: 1px solid rgba(20, 38, 77, .14);
    border-radius: 16px; box-shadow: 0 18px 46px rgba(22, 43, 35, .24);
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
}
.ls-collab-panel > * { min-width: 0; max-width: 100%; }
.ls-collab-header { display: flex; align-items: center; gap: 10px; }
.ls-collab-brand { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 11px; background: linear-gradient(135deg,#fff5d4,#e8eef9); }
.ls-collab-brand img { width: 32px; height: 32px; object-fit: contain; }
.ls-collab-heading { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.ls-collab-heading strong { font-size: 17px; line-height: 20px; }
.ls-collab-heading span, .ls-section-heading span, .ls-add-label span { color: #66736d; font-size: 12px; line-height: 16px; }
.ls-icon-button, .ls-text-button, .ls-remove-collaborator, .ls-secondary-button, .ls-danger-button, .ls-member-name, .ls-search-result { font: inherit; }
.ls-icon-button { width: 30px; height: 30px; border: 0; border-radius: 8px; background: #f2f5fa; color: #32415f; font-size: 22px; cursor: pointer; }
.ls-icon-button:hover { background: #e8edf6; }
.ls-collab-stats { display: flex; gap: 8px; }
.ls-collab-stats > span { display: flex; align-items: center; gap: 5px; padding: 6px 9px; border-radius: 999px; background: #f3f6fb; color: #354665; font-size: 12px; }
.ls-online-dot, .ls-member-presence { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #20b86a; box-shadow: 0 0 0 2px #fff; }
.ls-section-heading { display: flex; align-items: end; justify-content: space-between; }
.ls-section-heading > div, .ls-add-label { display: flex; flex-direction: column; }
.ls-section-heading strong, .ls-add-label strong { font-size: 14px; }
.ls-text-button { border: 0; padding: 4px; background: transparent; color: #14264d; font-weight: 700; cursor: pointer; }
.ls-text-button:hover { text-decoration: underline; }
.ls-shared-list { max-height: 188px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin: 0 -4px; padding: 0 4px; }
.ls-collab-member { min-height: 48px; display: grid; grid-template-columns: 38px minmax(0,1fr) auto 28px; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 10px; }
.ls-collab-member[hidden], .ls-empty-state[hidden], .ls-mini-spinner[hidden] { display: none; }
.ls-collab-member:hover { background: #f4f8f6; }
.ls-member-avatar, .ls-result-avatar { position: relative; width: 38px; height: 38px; border-radius: 50%; background-position: center; background-size: cover; background-color: #dfe9e5; }
.ls-member-presence { display: none; position: absolute; right: 0; bottom: 0; }
.ls-collab-member.is-online .ls-member-presence { display: block; }
.ls-member-name { min-width: 0; overflow: hidden; padding: 0; border: 0; background: transparent; color: #23342d; font-weight: 700; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ls-member-name:hover { color: #14264d; text-decoration: underline; }
.ls-member-role { padding: 3px 7px; border-radius: 999px; background: #edf3f0; color: #68756f; font-size: 10px; font-weight: 700; }
.ls-collab-member.is-owner .ls-member-role { background: #fff1c7; color: #795c0a; }
.ls-remove-collaborator { width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: #9b5555; font-size: 20px; cursor: pointer; }
.ls-remove-collaborator:hover { background: #ffebeb; color: #ba3030; }
.ls-empty-state { padding: 14px; border: 1px dashed #cbd8d2; border-radius: 10px; color: #74827c; font-size: 12px; text-align: center; }
.ls-divider { height: 1px; background: #e5ece9; }
.ls-search-wrap { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; max-width: 100%; overflow: hidden; }
#searchy { display: block !important; box-sizing: border-box !important; inline-size: 100% !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; max-inline-size: 100% !important; height: 40px !important; margin: 0 !important; padding: 0 40px 0 12px !important; border: 1px solid #c7d3ce !important; border-radius: 10px !important; outline: 0; color: #1f2d27; background: #fff; font: inherit; }
#searchy:focus { border-color: #e7a91b; box-shadow: 0 0 0 3px rgba(255,200,61,.16); }
.ls-mini-spinner { position: absolute; right: 13px; top: 12px; width: 16px; height: 16px; border: 2px solid #cbe2d8; border-top-color: #14264d; border-radius: 50%; animation: spin .7s linear infinite; }
.ls-search-result { width: 100%; display: grid; grid-template-columns: 38px 1fr 28px; align-items: center; gap: 10px; padding: 7px; border: 1px solid #dce7e2; border-radius: 11px; color: #203129; background: #f7fbf9; cursor: pointer; text-align: left; }
.ls-search-result:hover { border-color: #8fcab2; background: #edf8f3; }
.ls-search-result[hidden] { display: none; }
.ls-result-copy { min-width: 0; display: flex; flex-direction: column; }
.ls-result-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ls-result-copy small { color: #687970; }
.ls-result-add { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: #fff; background: #e7a91b; font-size: 20px; }
.ls-share-status { min-height: 16px; color: #587067; font-size: 12px; line-height: 16px; overflow-wrap: anywhere; white-space: normal; }
.ls-share-status.is-error { color: #b43b3b; }
.ls-share-status.is-success { color: #14264d; }
.ls-native-backpack { box-sizing: border-box; flex: 0 0 auto; width: 100%; height: 46px; overflow: hidden; border-top: 1px solid #d9e3f2; background: #fff; color: #334; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; transition: height .18s ease, border-color .18s ease, box-shadow .18s ease; }
.ls-native-backpack.is-expanded { height: 210px; box-shadow: 0 -5px 15px rgba(35,55,85,.09); }
.ls-native-backpack.is-drop-target { border-color: #ffc83d; background: #fff9e9; box-shadow: inset 0 0 0 3px rgba(255,200,61,.28); }
.ls-native-backpack-header { box-sizing: border-box; width: 100%; height: 45px; display: flex; align-items: center; gap: 9px; padding: 0 14px; border: 0; color: #4c4c4c; background: #fff; font: inherit; font-size: 13px; font-weight: 700; text-align: left; cursor: pointer; }
.ls-native-backpack-header:hover { background: #f7f9fc; }
.ls-native-backpack-icon { width: 25px; height: 25px; display: grid; place-items: center; border-radius: 7px; background: #fff; font-size: 14px; }
.ls-native-backpack-title { flex: 1; }
.ls-native-backpack-count { color: #777; font-size: 11px; font-weight: 500; }
.ls-native-backpack-chevron { color: #777; font-size: 18px; transform: rotate(-90deg); transition: transform .18s ease; }
.ls-native-backpack.is-expanded .ls-native-backpack-chevron { transform: rotate(90deg); }
.ls-native-backpack-body { box-sizing: border-box; height: 164px; display: flex; flex-direction: column; padding: 8px 12px 10px; border-top: 1px solid #edf0f5; }
.ls-native-backpack-list { min-width: 0; flex: 1; display: flex; align-items: stretch; gap: 9px; overflow-x: auto; overflow-y: hidden; padding: 1px 1px 5px; }
.ls-native-backpack-empty { width: 100%; display: grid; place-items: center; border: 2px dashed #cdd8e8; border-radius: 8px; color: #718096; font-size: 12px; text-align: center; }
.ls-native-backpack-item { position: relative; box-sizing: border-box; flex: 0 0 152px; min-width: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 10px; border: 1px solid #dce3ed; border-radius: 8px; background: #fff; cursor: grab; box-shadow: 0 1px 3px rgba(40,55,80,.08); }
.ls-native-backpack-item:hover { border-color: #75bfe9; box-shadow: 0 2px 7px rgba(40,95,130,.15); }
.ls-native-backpack-item:active { cursor: grabbing; }
.ls-native-backpack-preview { width: 100%; height: 62px; object-fit: contain; object-position: left center; pointer-events: none; }
.ls-native-backpack-item-title { overflow: hidden; color: #4c4c4c; font-size: 12px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.ls-native-backpack-item-meta { overflow: hidden; color: #7b8491; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.ls-native-backpack-item-actions { display: flex; align-items: center; justify-content: space-between; gap: 5px; }
.ls-native-backpack-use, .ls-native-backpack-delete, .ls-native-backpack-refresh { border: 0; background: transparent; color: #14264d; font: inherit; font-size: 10px; font-weight: 700; cursor: pointer; }
.ls-native-backpack-delete { color: #b54a4a; }
.ls-native-backpack-status { min-height: 15px; color: #647487; font-size: 11px; }
.ls-native-backpack-status.is-error { color: #b43b3b; }
.ls-native-backpack-status.is-success { color: #14264d; }
.ls-collab-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ls-collab-actions .ls-danger-button { grid-column: 1 / -1; }
.ls-secondary-button, .ls-danger-button { min-width: 0; min-height: 36px; padding: 7px 10px; border-radius: 9px; overflow: hidden; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ls-secondary-button { border: 1px solid #b8c4da; color: #14264d; background: #fff; }
.ls-secondary-button:hover { background: #eef3fc; }
.ls-danger-button { border: 1px solid #efc5c5; color: #a33939; background: #fff7f7; }
.ls-danger-button:hover { background: #ffecec; }
#lsShare { transition: transform .16s ease, filter .16s ease, box-shadow .16s ease; }
#lsShare:hover { filter: brightness(1.06); transform: translateY(-1px); }
#lsShare:focus-visible { outline: 3px solid rgba(95,210,165,.42); outline-offset: 2px; }
.ls-share-button-icon { width: 18px; height: 18px; display: inline-flex; }
.ls-share-button-icon svg { width: 100%; height: 100%; }
.ls-notification-button { position: relative; width: 36px; min-width: 36px; height: 36px; margin-right: 8px; padding: 8px !important; border-radius: 9px !important; color: #14264d !important; background: rgba(255,255,255,.92) !important; box-shadow: 0 2px 8px rgba(20,38,77,.14); cursor: pointer; }
.ls-notification-button:hover { background: #fff8df !important; transform: translateY(-1px); }
.ls-notification-button > svg { width: 20px; height: 20px; }
.ls-notification-badge { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 4px; display: grid; place-items: center; border: 2px solid #855cd6; border-radius: 999px; color: #fff; background: #d33b54; font-size: 9px; font-weight: 800; line-height: 1; }
.ls-notification-badge[hidden] { display: none; }
#lsNotificationCenter { position: absolute; top: 44px; right: 8px; z-index: 1100; width: min(340px, calc(100vw - 24px)); max-height: min(430px, calc(100vh - 70px)); overflow: hidden; border: 1px solid rgba(20,38,77,.14); border-radius: 15px; color: #14264d; background: #fff; box-shadow: 0 18px 46px rgba(22,43,35,.26); font-family: "Helvetica Neue",Helvetica,Arial,sans-serif; }
#lsNotificationCenter[hidden], #lsNotificationToast[hidden] { display: none; }
.ls-notification-header { display: flex; align-items: center; justify-content: space-between; padding: 13px 14px 11px; border-bottom: 1px solid #e7ebf2; background: linear-gradient(120deg,#fffdf7,#ffe399); }
.ls-notification-header > div { display: flex; flex-direction: column; }
.ls-notification-header strong { color: #14264d; font-size: 15px; }
.ls-notification-header span { color: #63708a; font-size: 11px; }
.ls-notification-clear { padding: 5px 7px; border: 0; border-radius: 7px; color: #14264d; background: rgba(255,255,255,.65); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.ls-notification-clear:hover { background: #fff; }
.ls-notification-list { max-height: 360px; overflow-y: auto; overscroll-behavior: contain; padding: 6px; }
.ls-notification-item { box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 9px; padding: 9px; border: 0; border-radius: 10px; color: #14264d; background: transparent; font: inherit; text-align: left; cursor: pointer; }
.ls-notification-item:hover { background: #f3f6fb; }
.ls-notification-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; color: #425a88; background: #eaf0fb; }
.ls-notification-icon svg { width: 18px; height: 18px; }
.ls-notification-item.is-chat .ls-notification-icon { color: #765a00; background: #fff1b8; }
.ls-notification-item.is-join .ls-notification-icon, .ls-notification-item.is-success .ls-notification-icon { color: #14734a; background: #dff5ea; }
.ls-notification-item.is-leave .ls-notification-icon { color: #5f6b80; background: #edf0f5; }
.ls-notification-item.is-error .ls-notification-icon { color: #a33242; background: #ffe8ec; }
.ls-notification-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ls-notification-copy strong { overflow: hidden; color: #1e2f51; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ls-notification-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #53617a; font-size: 11px; line-height: 15px; }
.ls-notification-copy time { color: #8993a5; font-size: 9px; }
.ls-notification-empty { padding: 34px 16px; color: #768196; font-size: 12px; text-align: center; }
#lsNotificationToast { position: absolute; top: 44px; right: 8px; z-index: 1090; width: min(300px, calc(100vw - 24px)); display: flex; flex-direction: column; gap: 3px; padding: 11px 13px; border: 1px solid rgba(20,38,77,.14); border-left: 4px solid #e7b326; border-radius: 11px; color: #14264d; background: #fff; box-shadow: 0 12px 34px rgba(20,38,77,.22); font: inherit; text-align: left; cursor: pointer; }
#lsNotificationToast { box-sizing: border-box; touch-action: pan-y; user-select: none; }
#lsNotificationToast strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #14264d; font-size: 12px; }
#lsNotificationToast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #53617a; font-size: 11px; line-height: 15px; }
#lsNotificationToast.is-error { border-left-color: #d33b54; }
#lsNotificationToast.is-join, #lsNotificationToast.is-success { border-left-color: #27a76f; }
#lsNotificationToast.is-leave { border-left-color: #758198; }
@media (max-width: 360px) {
    .ls-collab-panel { padding: 13px; gap: 10px; }
    .ls-collab-actions { grid-template-columns: 1fr; }
    .ls-collab-actions .ls-danger-button { grid-column: auto; }
    .ls-collab-member { grid-template-columns: 34px minmax(0,1fr) auto; }
    .ls-collab-member .ls-remove-collaborator { grid-column: 3; }
    .ls-member-role { display: none; }
}
.livescratchloader {
    border: 3px solid #ffc83d;
    border-top: 3px solid white;
    border-bottom: 3px solid white;
    border-radius: 50%;
    width: 13px;
    height: 13px;
    animation: spin 2s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }



#lsUsersPanel { box-sizing: border-box; flex: 0 1 auto; display: flex; align-items: center; gap: 6px; width: calc(80px + var(--ls-online-count, 1) * 110px); min-width: 100px; max-width: 360px; padding: 3px 6px; }
.ls-online-users { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(var(--ls-online-columns, 1), minmax(0, 1fr)); gap: 4px; max-height: 42px; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
.ls-online-users.is-avatars .ls-online-name { display: none; }
.ls-online-users.is-avatars .ls-online-user { justify-content: center; gap: 0; padding: 2px; border-radius: 6px; }
.ls-online-users.is-dense { gap: 2px; }
.ls-online-label { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; padding-right: 3px; color: #fff; font-size: 11px; font-weight: 700; white-space: nowrap; }
.ls-online-label::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #b5f5ce; }
.ls-online-user { box-sizing: border-box; flex: 0 0 auto; display: flex; align-items: center; gap: 6px; height: calc(var(--ls-online-avatar-size, 24px) + 6px); min-width: 0; max-width: 132px; padding: 2px 6px 2px 2px; border: 1px solid var(--ls-user-color); border-radius: 9px; color: #14264d; background: var(--ls-user-bg); font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; transition: box-shadow .15s ease, background .15s ease; }
.ls-online-user:hover { background: #fff; box-shadow: inset 0 0 0 1px var(--ls-user-color); }
.ls-online-user:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.ls-online-avatar { flex: 0 0 var(--ls-online-avatar-size, 24px); width: var(--ls-online-avatar-size, 24px); height: var(--ls-online-avatar-size, 24px); object-fit: cover; border-radius: 6px; background: #fff; }
.ls-online-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#lsOnlineTooltip { position: fixed; z-index: 10000; max-width: min(280px, calc(100vw - 16px)); padding: 6px 9px; border-radius: 6px; color: #fff; background: #25334d; box-shadow: 0 3px 10px #0003; font: 12px/1.4 "Helvetica Neue", Helvetica, Arial, sans-serif; overflow-wrap: anywhere; pointer-events: none; }
#lsOnlineTooltip[hidden] { display: none; }
#lsCollaboratorPointers { position: fixed; inset: 0; z-index: 900; overflow: hidden; pointer-events: none; }
.ls-live-pointer { position: absolute; top: 0; left: 0; pointer-events: none; transition: transform 70ms linear; color: var(--ls-pointer-color); }
.ls-live-pointer svg { display: block; width: 19px; height: 24px; filter: drop-shadow(0 1px 1px #0003); }
.ls-live-pointer span { display: block; width: max-content; max-width: 130px; margin: -3px 0 0 14px; padding: 3px 6px; border-radius: 4px; color: #fff; background: var(--ls-pointer-color); font: 700 11px/1.3 "Helvetica Neue", Helvetica, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { .ls-live-pointer { transition: none; } }

// highlight blocks


.tag{
    position: absolute;
    /* outline-color: #58c198; */
    /* transform:translate(150px,50px) ;     */
    transform:translate(-110px,0px)  ;

}
.tagName{
    color:white;
    padding: 4px;
border-radius: 20px;

}

.usernameTag{   
    position: absolute;
    /* transform:rotate(-135deg)  ; */
    top:90px;

    font-size: 30px;
    font-family: helvetica;
    font-weight: bold;
    text-align: center;
    width: 100px;
  
    opacity: 0;

transition: .2s;


display: flex;
align-self: center;
align-items: center;
justify-content: center;
justify-items:center;

}

.tag:hover .usernameTag{
    opacity: 1;
}

.circle {
    position:absolute;
    width:100px;
    height:100px;
    border-radius: 100%;
    left:0px;
    top:0px;
    background: url("https://img.freepik.com/premium-photo/astronaut-outer-open-space-planet-earth-stars-provide-background-erforming-space-planet-earth-sunrise-sunset-our-home-iss-elements-this-image-furnished-by-nasa_150455-16829.jpg?w=2000");
    background-size: cover;
}

.square{    
    position:absolute;
    transform: translate(4px,3px) rotate(135deg);
    transform-origin: bottom right;
    width:50px;
    height:50px;
    top:0;
    left:0px;

}

.tag.turnOn {
    animation-name: indicateOn;
    animation-duration: .25s;
    animation-fill-mode:forwards;

}
.tag.turnOff{
    animation-name: indicateOff;
    animation-duration: .25s;
    animation-fill-mode:forwards;
}

@keyframes indicateOn {
    from {
        transform:translate(-170px,0px);
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
@keyframes indicateOff {
    from {
        opacity: 1;

    }
    to {
        transform:translate(-170px,0px);
        opacity: 0;
    }
}


.blocRect{
    outline-style: solid;
    outline-width: 0px;
    border-radius: 20px;
}
/* .pinkOutline{
    outline-color: #58c198;
}
.blueOutline{
    outline-color: rgb(0, 99, 165);
} */
.blocRect.turnOn {
    animation-name: outlineSelect;
    animation-duration: .25s;
    animation-fill-mode:forwards;
}
.blocRect.turnedOn {
    outline-offset: 0px;
}
.blocRect path {
    transition: stroke-width: .3s;
}

.turnedOn path:not([data-shapes="round"] > path) {
    stroke: #58c198;
    stroke-width: 2.5px;
}

.blocRect.turnOff{
    animation-name: outlineUnselect;
    animation-duration: .25s;
    animation-fill-mode:forwards;
}

.blocRect.turnedOff{
    outline:none;
}

.blockly-name-tag {
    opacity: 1;
    transition: opacity .3s;
}

.turnedOff > .blockly-name-tag {
    opacity: 0;
}

@keyframes outlineSelect {
    from {
        outline-offset: 20px;
        outline-color: rgba(0,0,0,0);
    }
    to {
        outline-offset: 0px;
    }
}
@keyframes outlineUnselect {
    to {
        outline-offset: 20px;
        outline-color: rgba(0,0,0,0);
    }
    from {
        outline-offset: 0px;
    }
}



`;




usersCache = {};

async function getUserInfo(username) {
    if (!username) { return; }
    if (['coblocks', 'livescratch'].includes(username.toLowerCase())) {
        return { username, pic: logoUrl };
    }
    if (username?.toLowerCase() in usersCache && usersCache[username?.toLowerCase()]?.pk) {
        return usersCache[username?.toLowerCase()];
    }

    let res;
    try {
        res = await (await fetch('https://scratch.mit.edu/site-api/users/all/' + username?.toLowerCase())).json();
    } catch (e) {
        return { username, pic: 'https://scratch.mit.edu/favicon.ico' };
    }
    if (!res) {
        return { username, pic: 'https://scratch.mit.edu/favicon.ico' };
    }

    let user = res.user;
    user = await getWithPic(user, username);
    try {
        usersCache[user.username.toLowerCase()] = user;
    } catch {
        user = await getWithPic({ username: username }, username);
        usersCache[username.toLowerCase()] = user;
    }
    return user;
}

async function getWithPic(user, username = null) {
    if (username !== null && username === 'livescratch') {
        const url = await new Promise((resolve, reject) => {
            window.coBlocksRuntime.sendMessage(exId, { meta: 'getUrl', for: '/img/CoBlocksIcon.png' }, (url) => {
                if (window.coBlocksRuntime.lastError) {
                    reject(window.coBlocksRuntime.lastError);
                } else {
                    resolve(url);
                }
            });
        });
        user.pic = url;
        return user;
    } else {
        user.pic = `https://uploads.scratch.mit.edu/get_image/user/${user.pk}_60x60.png`;
        return user;
    }
}


async function addCollaboratorGUI (user, omitX) {
    if (!user) { return; }
    if (user.username.toLowerCase() in lsShareMembers) { return; }

    const newCollab = lsCollaboratorTemplate.cloneNode(-1);
    newCollab.removeAttribute('id');
    newCollab.hidden = false;
    newCollab.dataset.username = user.username.toLowerCase();
    const name = newCollab.querySelector('.ls-member-name');
    name.innerText = user.username;
    name.onclick = () => window.open(`https://scratch.mit.edu/users/${encodeURIComponent(user.username)}`);
    const x = newCollab.querySelector('.ls-remove-collaborator');
    if (omitX === true) {
        x.remove();
        newCollab.classList.add('is-owner');
        newCollab.querySelector('.ls-member-role').innerText = 'Owner';
    } else {
        x.username = user.username;
        x.onclick = () => removeCollaborator(user.username);
    }
    newCollab.querySelector('.ls-member-avatar').style.backgroundImage = `url('${user.pic}')`;
    lsShareMembers[user.username.toLowerCase()] = newCollab;
    const sharedList = document.querySelector('#lsSharedList');
    sharedList.insertBefore(newCollab, document.querySelector('#lsEmptyCollaborators'));

    lsSearchResult.hidden = true;
    lsSearchInput.value = '';
    updateCollaboratorSummary();
}

async function removeCollaboratorGUI (username) {
    if (!(username.toLowerCase() in lsShareMembers)) { return; }
    lsShareMembers[username.toLowerCase()].remove();
    delete lsShareMembers[username.toLowerCase()];
    updateCollaboratorSummary();
}

function removeAllCollaboratorsGUI() {
    Object.values(lsShareMembers).forEach(div => div.remove());
    lsShareMembers = {};
    updateCollaboratorSummary();
}

async function addCollaborator(username) {
    if (!username) return;
    if (username.toLowerCase() in lsShareMembers) { return; }
    const user = await getUserInfo(username);
    if (!user) { setShareStatus('No Scratch user found.', 'error'); return; }
    setShareStatus(`Adding @${user.username}...`);
    window.coBlocksRuntime.sendMessage(exId, { meta: 'shareWith', 'username': user.username, id: lsId, pk: user.pk }, function (response) {
        if (response?.ok) {
            addCollaboratorGUI(user);
            setShareStatus(`@${user.username} can now collaborate.`, 'success');
            creditCollabers([...Object.keys(lsShareMembers)]);
        } else {
            setShareStatus(response?.error || 'This user must sign in to CoBlocks first.', 'error');
        }
    });
}

function removeCollaborator(user) {
    if (!confirm(`Remove @${user} from this project?`)) return;
    setShareStatus(`Removing @${user}...`);
    window.coBlocksRuntime.sendMessage(exId, { meta: 'unshareWith', user, id: lsId }, response => {
        if (response?.ok) {
            removeCollaboratorGUI(user);
            setShareStatus(`@${user} was removed.`, 'success');
            creditCollabers([...Object.keys(lsShareMembers)]);
        } else {
            setShareStatus(response?.error || `Could not remove @${user}.`, 'error');
        }
    });
}

function setShareStatus(message, type = '') {
    const status = document.querySelector('#lsShareStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `ls-share-status${type ? ` is-${type}` : ''}`;
    if (message && type) {
        addCoBlocksNotification({
            type,
            title: type === 'error' ? 'Something went wrong' : 'Collaboration updated',
            message,
        });
    }
}

const coBlocksNotifications = [];
let notificationToastTimer;
let notificationToastAnimation;

function notificationIcon(type) {
    const icons = {
        bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"></path>',
        chat: '<path d="M4 5.5h16v11H9l-5 3v-14Z"></path><path d="M8 10h8M8 13h5"></path>',
        join: '<circle cx="9" cy="8" r="3"></circle><path d="M3.5 19c.6-3.3 2.4-5 5.5-5s4.9 1.7 5.5 5M18 7v6M15 10h6"></path>',
        leave: '<circle cx="9" cy="8" r="3"></circle><path d="M3.5 19c.6-3.3 2.4-5 5.5-5s4.9 1.7 5.5 5M15 10h6"></path>',
        error: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6M12 17h.01"></path>',
        success: '<circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16.5 9"></path>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[type] || icons.success}</svg>`;
}

function createNotificationsButton(shareButton) {
    const button = document.createElement('button');
    button.id = 'lsNotificationsButton';
    button.type = 'button';
    button.className = `${copyMatchingClasses(shareButton, ['button_outlined-button', 'menu-bar_menu-bar-button'])} ls-notification-button`;
    button.setAttribute('aria-label', 'Open CoBlocks notifications');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'CoBlocks notifications';
    button.innerHTML = `${notificationIcon('bell')}<span class="ls-notification-badge" hidden>0</span>`;
    button.onclick = toggleNotificationCenter;
    return button;
}

function createNotificationCenter() {
    const panel = document.createElement('section');
    panel.id = 'lsNotificationCenter';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'CoBlocks notifications');
    panel.innerHTML = `
        <div class="ls-notification-header">
            <div><strong>Notifications</strong><span>Project activity</span></div>
            <button type="button" class="ls-notification-clear">Clear</button>
        </div>
        <div class="ls-notification-list"></div>`;
    panel.querySelector('.ls-notification-clear').onclick = () => {
        coBlocksNotifications.length = 0;
        updateNotificationBadge();
        renderNotificationCenter();
    };
    return panel;
}

function createNotificationToast() {
    const toast = document.createElement('button');
    toast.id = 'lsNotificationToast';
    toast.type = 'button';
    toast.hidden = true;
    toast.innerHTML = '<strong></strong><span></span>';
    let pointerStart = null;
    let swipeDistance = 0;
    let suppressClick = false;
    toast.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
        swipeDistance = 0;
        suppressClick = false;
        clearTimeout(notificationToastTimer);
        notificationToastAnimation?.cancel();
        toast.setPointerCapture(event.pointerId);
    });
    toast.addEventListener('pointermove', event => {
        if (!pointerStart || pointerStart.id !== event.pointerId) return;
        const dx = event.clientX - pointerStart.x;
        const dy = event.clientY - pointerStart.y;
        swipeDistance = dx > Math.abs(dy) ? Math.max(0, dx) : 0;
        if (swipeDistance > 8) suppressClick = true;
        toast.style.transform = `translateX(${swipeDistance}px)`;
        toast.style.opacity = String(Math.max(0.2, 1 - swipeDistance / toast.offsetWidth));
    });
    const finishSwipe = event => {
        if (!pointerStart || pointerStart.id !== event.pointerId) return;
        pointerStart = null;
        if (event.type !== 'pointercancel' && swipeDistance >= Math.min(70, toast.offsetWidth / 4)) {
            suppressClick = true;
            dismissNotificationToast(true);
        } else {
            toast.style.transform = '';
            toast.style.opacity = '';
            notificationToastTimer = setTimeout(dismissNotificationToast, 1600);
        }
    };
    toast.addEventListener('pointerup', finishSwipe);
    toast.addEventListener('pointercancel', finishSwipe);
    toast.addEventListener('click', event => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    toast.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') suppressClick = false;
        if (event.key === 'Escape') dismissNotificationToast();
    });
    return toast;
}

function dismissNotificationToast(swipe = false) {
    clearTimeout(notificationToastTimer);
    const toast = document.querySelector('#lsNotificationToast');
    if (!toast || toast.hidden) return;
    notificationToastAnimation?.cancel();
    const style = getComputedStyle(toast);
    const animation = toast.animate([
        { opacity: style.opacity, transform: style.transform },
        { opacity: 0, transform: swipe ? 'translateX(calc(100% + 16px))' : 'translateY(-8px) scale(.96)' },
    ], {
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
        easing: 'ease-in',
        fill: 'forwards',
    });
    notificationToastAnimation = animation;
    animation.finished.then(() => {
        if (notificationToastAnimation !== animation) return;
        toast.hidden = true;
        toast.style.transform = '';
        toast.style.opacity = '';
        animation.cancel();
    }).catch(() => {});
}

function notificationAction(notification) {
    closeNotificationCenter();
    dismissNotificationToast();
    if (notification.action === 'chat') {
        const chat = document.querySelector('ls-chat');
        if (chat) {
            toggleChat(true);
            chat.querySelector('ls-chat-input')?.focus();
        }
    } else if (notification.action === 'collaboration' && lsDropdown) {
        lsDropdown.style.display = 'flex';
        coblocksButton?.setAttribute('aria-expanded', 'true');
        refreshShareModal();
    }
}

function renderNotificationCenter() {
    const list = document.querySelector('.ls-notification-list');
    if (!list) return;
    list.replaceChildren();
    if (!coBlocksNotifications.length) {
        const empty = document.createElement('div');
        empty.className = 'ls-notification-empty';
        empty.textContent = 'No notifications yet';
        list.appendChild(empty);
        return;
    }

    for (const notification of coBlocksNotifications) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `ls-notification-item is-${notification.type}`;
        item.title = `${notification.title}\n${notification.message}`;
        item.innerHTML = `
            <span class="ls-notification-icon">${notificationIcon(notification.type)}</span>
            <span class="ls-notification-copy"><strong></strong><span></span><time></time></span>`;
        item.querySelector('strong').textContent = notification.title;
        item.querySelector('.ls-notification-copy > span').textContent = notification.message;
        item.querySelector('time').textContent = notification.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        item.onclick = () => notificationAction(notification);
        list.appendChild(item);
    }
}

function updateNotificationBadge() {
    const badge = document.querySelector('.ls-notification-badge');
    if (!badge) return;
    const unread = coBlocksNotifications.filter(notification => notification.unread).length;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
}

function showNotificationToast(notification) {
    const toast = document.querySelector('#lsNotificationToast');
    if (!toast || !document.querySelector('#lsNotificationCenter')?.hidden) return;
    clearTimeout(notificationToastTimer);
    notificationToastAnimation?.cancel();
    toast.style.transform = '';
    toast.style.opacity = '';
    toast.className = `is-${notification.type}`;
    toast.title = `${notification.title}\n${notification.message}`;
    toast.querySelector('strong').textContent = notification.title;
    toast.querySelector('span').textContent = notification.message;
    toast.hidden = false;
    notificationToastAnimation = toast.animate([
        { opacity: 0, transform: 'translateY(-8px) scale(.96)' },
        { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], {
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
        easing: 'ease-out',
    });
    toast.onclick = () => notificationAction(notification);
    notificationToastTimer = setTimeout(dismissNotificationToast, 1600);
}

function addCoBlocksNotification({ type = 'success', title, message, action = null }) {
    if (!title || !message) return;
    const unread = !(type === 'chat' && isChatOpen());
    const notification = { type, title, message: String(message), action, time: new Date(), unread };
    coBlocksNotifications.unshift(notification);
    if (coBlocksNotifications.length > 30) coBlocksNotifications.length = 30;
    updateNotificationBadge();
    renderNotificationCenter();
    showNotificationToast(notification);
    isPingEnabled().then(enabled => {
        if (enabled) playSound(pingUrl);
    });
}

function closeNotificationCenter() {
    const panel = document.querySelector('#lsNotificationCenter');
    const button = document.querySelector('#lsNotificationsButton');
    if (panel) panel.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
}

function toggleNotificationCenter() {
    const panel = document.querySelector('#lsNotificationCenter');
    const button = document.querySelector('#lsNotificationsButton');
    if (!panel || !button) return;
    const opening = panel.hidden;
    panel.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening) {
        if (lsDropdown) lsDropdown.style.display = 'none';
        coblocksButton?.setAttribute('aria-expanded', 'false');
        coBlocksNotifications.forEach(notification => { notification.unread = false; });
        updateNotificationBadge();
        renderNotificationCenter();
        dismissNotificationToast();
    }
}

let lsBackpackItems = [];
let lsBackpackOwner = '';
let lsBackpackUsername = '';
let lsBackpackBlockDragOutside = false;
let lsBackpackBlockDragOver = false;
let lsBackpackListenersInstalled = false;
let lsBackpackPointer = null;

function setBackpackStatus(message, type = '') {
    const status = document.querySelector('#lsNativeBackpackStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `ls-native-backpack-status${type ? ` is-${type}` : ''}`;
}

function requestFromBackground(message, timeoutMs = 15000) {
    return new Promise(resolve => {
        let finished = false;
        const finish = response => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            resolve(response);
        };
        const timeout = setTimeout(() => finish({ ok: false, error: 'The CoBlocks server did not respond. Try again.' }), timeoutMs);
        window.coBlocksRuntime.sendMessage(exId, message, response => {
            if (window.coBlocksRuntime.lastError) {
                finish({ ok: false, error: 'CoBlocks could not contact the extension. Reload the editor and try again.' });
                return;
            }
            finish(response);
        });
    });
}

function pointerIsOverBackpack() {
    const backpack = document.querySelector('#lsNativeBackpack');
    if (!backpack || !lsBackpackPointer) return false;
    const rect = backpack.getBoundingClientRect();
    return lsBackpackPointer.x >= rect.left && lsBackpackPointer.x <= rect.right &&
        lsBackpackPointer.y >= rect.top && lsBackpackPointer.y <= rect.bottom;
}

function updateBackpackDropTarget() {
    const backpack = document.querySelector('#lsNativeBackpack');
    if (!backpack) return;
    lsBackpackBlockDragOver = pointerIsOverBackpack();
    backpack.classList.toggle('is-drop-target', lsBackpackBlockDragOutside && lsBackpackBlockDragOver);
}

function rememberBackpackPointer(event) {
    const point = event.touches?.[0] || event.changedTouches?.[0] || event;
    if (!Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) return;
    lsBackpackPointer = { x: point.clientX, y: point.clientY };
    if (lsBackpackBlockDragOutside) updateBackpackDropTarget();
}

function resizeEditorForBackpack() {
    const resize = () => {
        window.dispatchEvent(new Event('resize'));
        try {
            const workspace = typeof BL_UTILS !== 'undefined' ? BL_UTILS.getWorkspace?.() : null;
            workspace?.resize?.();
            if (typeof ScratchBlocks !== 'undefined') ScratchBlocks.svgResize?.(workspace);
        } catch (error) { console.error('Could not resize the Scratch workspace:', error); }
    };
    resize();
    setTimeout(resize, 200);
    setTimeout(resize, 420);
}

async function toggleSharedBackpack() {
    const backpack = document.querySelector('#lsNativeBackpack');
    if (!backpack) return;
    const expanded = !backpack.classList.contains('is-expanded');
    backpack.classList.toggle('is-expanded', expanded);
    backpack.querySelector('.ls-native-backpack-header')?.setAttribute('aria-expanded', String(expanded));
    resizeEditorForBackpack();
    if (expanded) await refreshSharedBackpack();
}

function backpackScriptName(blocks, topBlockId) {
    try {
        const workspace = typeof BL_UTILS !== 'undefined' ? BL_UTILS.getWorkspace?.() : null;
        const displayText = workspace?.getBlockById?.(topBlockId)?.toString?.(48)?.trim();
        if (displayText) return displayText.slice(0, 80);
    } catch { /* fall back to the VM opcode */ }
    const top = blocks.find(block => block.topLevel) || blocks[0];
    const opcode = String(top?.opcode || 'script').replace(/^[^_]+_/, '').replaceAll('_', ' ');
    return opcode.charAt(0).toUpperCase() + opcode.slice(1);
}

function renderSharedBackpack() {
    const list = document.querySelector('#lsNativeBackpackList');
    const count = document.querySelector('#lsNativeBackpackCount');
    if (!list || !count) return;
    count.textContent = `${lsBackpackItems.length} ${lsBackpackItems.length === 1 ? 'item' : 'items'}`;
    list.replaceChildren();
    if (!lsBackpackItems.length) {
        const empty = document.createElement('div');
        empty.className = 'ls-native-backpack-empty';
        empty.textContent = 'Drag a block stack here to share it with this project’s collaborators.';
        list.appendChild(empty);
        return;
    }
    for (const item of lsBackpackItems) {
        const row = document.createElement('div');
        row.className = 'ls-native-backpack-item';
        row.draggable = true;
        row.title = 'Drag into the code area or double-click to add to the current sprite';
        const name = document.createElement('strong');
        name.className = 'ls-native-backpack-item-title';
        name.textContent = item.name;
        if (item.thumbnail) {
            const preview = document.createElement('img');
            preview.className = 'ls-native-backpack-preview';
            preview.src = item.thumbnail;
            preview.alt = '';
            row.appendChild(preview);
        }
        const creator = document.createElement('small');
        creator.className = 'ls-native-backpack-item-meta';
        creator.textContent = `Shared by @${item.createdBy}`;
        const buttons = document.createElement('div');
        buttons.className = 'ls-native-backpack-item-actions';
        const useButton = document.createElement('button');
        useButton.className = 'ls-native-backpack-use';
        useButton.type = 'button';
        useButton.textContent = 'Add to sprite';
        useButton.onclick = () => insertBackpackScript(item.id);
        buttons.appendChild(useButton);
        const canDelete = String(item.createdBy).toLowerCase() === lsBackpackUsername || lsBackpackUsername === lsBackpackOwner;
        if (canDelete) {
            const deleteButton = document.createElement('button');
            deleteButton.className = 'ls-native-backpack-delete';
            deleteButton.type = 'button';
            deleteButton.textContent = 'Remove';
            deleteButton.onclick = () => removeBackpackScript(item.id);
            buttons.appendChild(deleteButton);
        }
        row.ondblclick = event => {
            if (!event.target.closest('button')) insertBackpackScript(item.id);
        };
        row.ondragstart = event => {
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-livescratch-backpack', item.id);
            event.dataTransfer.setData('text/plain', item.name);
        };
        row.ondragend = event => {
            const target = document.elementFromPoint(event.clientX, event.clientY);
            if (target?.closest?.('.blocklySvg, [class*="blocks_blocks"]')) insertBackpackScript(item.id);
        };
        row.append(name, creator, buttons);
        list.appendChild(row);
    }
}

async function refreshSharedBackpack(showStatus = false) {
    if (!lsId) return;
    if (showStatus) setBackpackStatus('Refreshing…');
    if (!lsBackpackUsername) {
        lsBackpackUsername = String(await requestFromBackground({ meta: 'getUsername' }) || '').toLowerCase();
    }
    const response = await requestFromBackground({ meta: 'getBackpack', id: lsId });
    if (!response?.ok || !Array.isArray(response.items)) {
        setBackpackStatus(response?.error || 'Could not load the shared backpack.', 'error');
        return;
    }
    lsBackpackItems = response.items;
    renderSharedBackpack();
    setBackpackStatus(showStatus ? 'Backpack updated.' : '', showStatus ? 'success' : '');
}

async function saveBlocksToBackpack(blocks, topBlockId) {
    try {
        if (!lsId || !Array.isArray(blocks) || !blocks.length) return;
        const ordered = blocks.map(block => ({ ...block }));
        const topIndex = ordered.findIndex(block => block.id === topBlockId);
        if (topIndex > 0) ordered.unshift(ordered.splice(topIndex, 1)[0]);
        const name = backpackScriptName(ordered, topBlockId);
        const thumbnail = await captureBackpackBlockThumbnail(topBlockId);
        setBackpackStatus('Sharing script…');
        const response = await requestFromBackground({
            meta: 'addBackpackItem',
            id: lsId,
            name,
            blocks: ordered,
            thumbnail,
        });
        if (!response?.ok) throw new Error(response?.error || 'Could not share that script.');
        await refreshSharedBackpack();
        setBackpackStatus('Script added for your collaborators.', 'success');
    } catch (error) {
        setBackpackStatus(error.message || 'Could not share that script.', 'error');
    }
}

function captureBackpackBlockThumbnail(topBlockId) {
    try {
        const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(topBlockId)) : String(topBlockId).replaceAll('"', '\\"');
        const candidates = [...document.querySelectorAll(`g[data-id="${escapedId}"]`)];
        const source = candidates.find(element => element.closest('.blocklyBlockCanvas, .blocklyDragSurface'));
        if (!source) return Promise.resolve(null);
        const bounds = source.getBBox();
        if (!bounds.width || !bounds.height) return Promise.resolve(null);
        const clone = source.cloneNode(true);
        clone.removeAttribute('transform');
        const padding = 5;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('viewBox', `${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}`);
        svg.appendChild(clone);
        const markup = new XMLSerializer().serializeToString(svg);
        const sourceUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
        return new Promise(resolve => {
            let finished = false;
            const finish = value => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                URL.revokeObjectURL(sourceUrl);
                resolve(value);
            };
            const timeout = setTimeout(() => finish(null), 1000);
            const image = new Image();
            image.onload = () => {
                try {
                    const scale = Math.min(1, 240 / bounds.width, 100 / bounds.height);
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.ceil((bounds.width + padding * 2) * scale));
                    canvas.height = Math.max(1, Math.ceil((bounds.height + padding * 2) * scale));
                    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                    finish(canvas.toDataURL('image/png'));
                } catch { finish(null); }
            };
            image.onerror = () => finish(null);
            image.src = sourceUrl;
        });
    } catch {
        return Promise.resolve(null);
    }
}

async function insertBackpackScript(itemId) {
    try {
        const item = lsBackpackItems.find(entry => entry.id === itemId);
        if (!item) throw new Error('That shared script is no longer available.');
        if (!Array.isArray(item.blocks) || !vm?.editingTarget?.id) throw new Error('This shared script is damaged.');
        await vm.shareBlocksToTarget(item.blocks, vm.editingTarget.id);
        vm.refreshWorkspace();
        setTimeout(() => {
            if (typeof BL_UTILS !== 'undefined') BL_UTILS.refreshFlyout?.();
        }, 120);
        setBackpackStatus(`Added “${item.name}” to the current sprite.`, 'success');
    } catch (error) {
        setBackpackStatus(error.message || 'Could not insert that script.', 'error');
    }
}

async function removeBackpackScript(itemId) {
    const item = lsBackpackItems.find(entry => entry.id === itemId);
    if (!item || !confirm(`Remove “${item.name}” from the shared backpack?`)) return;
    setBackpackStatus('Removing script...');
    const response = await requestFromBackground({ meta: 'deleteBackpackItem', id: lsId, itemId });
    if (!response?.ok) {
        setBackpackStatus(response?.error || 'Could not remove that script.', 'error');
        return;
    }
    await refreshSharedBackpack();
    setBackpackStatus('Script removed.', 'success');
}

function installSharedBackpackListeners() {
    if (lsBackpackListenersInstalled || !vm?.addListener) return;
    lsBackpackListenersInstalled = true;
    document.addEventListener('pointermove', rememberBackpackPointer, { capture: true, passive: true });
    document.addEventListener('mousemove', rememberBackpackPointer, { capture: true, passive: true });
    document.addEventListener('touchmove', rememberBackpackPointer, { capture: true, passive: true });
    vm.addListener('BLOCK_DRAG_UPDATE', isOutsideWorkspace => {
        lsBackpackBlockDragOutside = !!isOutsideWorkspace;
        updateBackpackDropTarget();
    });
    vm.addListener('BLOCK_DRAG_END', (blocks, topBlockId) => {
        // Blockly captures the mouse during block drags, so mouseenter can be skipped.
        // The last document-level pointer position is the reliable drop location.
        const droppedOnBackpack = pointerIsOverBackpack() || lsBackpackBlockDragOver;
        if (droppedOnBackpack) saveBlocksToBackpack(blocks, topBlockId);
        lsBackpackBlockDragOutside = false;
        lsBackpackBlockDragOver = false;
        lsBackpackPointer = null;
        document.querySelector('#lsNativeBackpack')?.classList.remove('is-drop-target');
    });
}

async function mountSharedBackpack() {
    let backpack = document.querySelector('#lsNativeBackpack');
    installSharedBackpackListeners();
    if (backpack) {
        backpack.hidden = false;
        refreshSharedBackpack();
        return;
    }
    const editorWrapper = await getObj('[class*="gui_editor-wrapper"]');
    backpack = document.createElement('section');
    backpack.id = 'lsNativeBackpack';
    backpack.className = 'ls-native-backpack';
    backpack.innerHTML = `
        <div class="ls-native-backpack-header" role="button" tabindex="0" aria-expanded="false">
            <span class="ls-native-backpack-icon" aria-hidden="true">🎒</span>
            <span class="ls-native-backpack-title">CoBlocks Backpack</span>
            <span id="lsNativeBackpackCount" class="ls-native-backpack-count">0 items</span>
            <button type="button" class="ls-native-backpack-refresh" aria-label="Refresh shared backpack">Refresh</button>
            <span class="ls-native-backpack-chevron" aria-hidden="true">›</span>
        </div>
        <div class="ls-native-backpack-body">
            <div id="lsNativeBackpackList" class="ls-native-backpack-list"></div>
            <div id="lsNativeBackpackStatus" class="ls-native-backpack-status" role="status" aria-live="polite"></div>
        </div>`;
    const header = backpack.querySelector('.ls-native-backpack-header');
    header.onclick = event => {
        if (!event.target.closest('.ls-native-backpack-refresh')) toggleSharedBackpack();
    };
    header.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleSharedBackpack();
        }
    };
    backpack.querySelector('.ls-native-backpack-refresh').onclick = event => {
        event.stopPropagation();
        refreshSharedBackpack(true);
    };
    backpack.onmouseenter = () => {
        lsBackpackBlockDragOver = true;
        backpack.classList.toggle('is-drop-target', lsBackpackBlockDragOutside);
    };
    backpack.onmouseleave = () => {
        lsBackpackBlockDragOver = false;
        backpack.classList.remove('is-drop-target');
    };
    editorWrapper.appendChild(backpack);
    renderSharedBackpack();
    refreshSharedBackpack();
    resizeEditorForBackpack();
}

function updateCollaboratorSummary(onlineUsers = null) {
    const members = Object.values(lsShareMembers);
    const empty = document.querySelector('#lsEmptyCollaborators');
    const count = document.querySelector('#lsCollabCount');
    if (empty) empty.hidden = members.length > 1;
    if (count) count.textContent = members.length;
    const peopleLabel = document.querySelector('#lsPeopleLabel');
    if (peopleLabel) peopleLabel.textContent = members.length === 1 ? 'person' : 'people';
    if (!onlineUsers) return;
    const onlineNames = new Set(onlineUsers.map(user => user.username.toLowerCase()));
    members.forEach(member => member.classList.toggle('is-online', onlineNames.has(member.dataset.username)));
    const onlineCount = document.querySelector('#lsOnlineCount');
    if (onlineCount) onlineCount.textContent = onlineNames.size;
}

function refreshCollaborationPresence() {
    if (!lsId) return;
    window.coBlocksRuntime.sendMessage(exId, { meta: 'getActive', id: lsId }, response => {
        if (Array.isArray(response)) updateCollaboratorSummary(response);
    });
}

async function copyCollaborationInvite() {
    setShareStatus('Creating invite...');
    window.coBlocksRuntime.sendMessage(exId, { meta: 'createInvite', id: lsId }, async response => {
        if (!response?.ok) {
            setShareStatus(response?.error || 'Could not create an invite.', 'error');
            return;
        }

        const inviteUrl = new URL('https://scratch.mit.edu/create');
        inviteUrl.searchParams.set('coblocksProject', response.projectId);
        inviteUrl.searchParams.set('coblocksInvite', response.token);
        try {
            await window.coBlocksRuntime.copyText(inviteUrl.href);
            setShareStatus('New invite copied. It expires in 7 days and replaces the previous link.', 'success');
        } catch {
            setShareStatus('Could not copy the invite link.', 'error');
        }
    });
}

function revokeCollaborationInvite() {
    if (!confirm('Revoke the current collaboration invite?')) return;
    setShareStatus('Revoking invite...');
    window.coBlocksRuntime.sendMessage(exId, { meta: 'revokeInvite', id: lsId }, response => {
        setShareStatus(
            response?.ok ? 'Invite revoked.' : response?.error || 'Could not revoke the invite.',
            response?.ok ? 'success' : 'error',
        );
    });
}

function refreshShareModal(showStatus = false) {
    if (!lsId) { return; }
    if (showStatus) setShareStatus('Refreshing...');
    return new Promise(promRes => {
        window.coBlocksRuntime.sendMessage(exId, { meta: 'getShared', id: lsId }, async (res) => {
            if (!Array.isArray(res)) {
                setShareStatus(res?.error || res?.err || 'Could not load collaborators.', 'error');
                promRes();
                return;
            }
            removeAllCollaboratorsGUI();
            for (const collaborator of res) {
                if (!collaborator.pk) collaborator.pk = (await getUserInfo(collaborator.username))?.pk;
            }
            const collaborators = await Promise.all(res.map(user => getWithPic(user)));
            const owner = collaborators.shift();
            if (owner) {
                lsBackpackOwner = owner.username.toLowerCase();
                await addCollaboratorGUI(owner, true);
                renderSharedBackpack();
            }
            for (const collaborator of collaborators) await addCollaboratorGUI(collaborator);
            refreshCollaborationPresence();
            if (showStatus) setShareStatus('Collaborators updated.', 'success');
            promRes();
        });
    });
}

function copyMatchingClasses(element, classFragments) {
    return Array.from(element.classList)
        .filter(className => classFragments.some(fragment => className.includes(fragment)))
        .join(' ');
}

function createCoBlocksButton(shareButton) {
    const button = document.createElement('livescratch-init');
    button.id = 'lsShare';
    button.className = copyMatchingClasses(shareButton, ['button_outlined-button', 'menu-bar_menu-bar-button']);
    button.style.marginRight = '10px';
    button.style.paddingLeft = '10px';
    button.style.paddingRight = '10px';
    button.style.gap = '6px';
    button.style.background = 'linear-gradient(120deg, #ffd45c, #ffe89a)';
    button.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,.45), 0 2px 8px rgba(20,38,77,.12)';
    button.style.color = '#14264d';
    button.style.display = 'flex';
    button.style.flexDirection = 'row';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', 'Open CoBlocks collaboration');
    button.setAttribute('aria-expanded', 'false');
    button.title = 'Open CoBlocks collaboration';
    button.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            button.click();
        }
    };

    const icon = document.createElement('span');
    icon.className = 'ls-share-button-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"></circle><circle cx="17" cy="9" r="2.5"></circle><path d="M3.5 19c.5-3.2 2.4-5 5.5-5s5 1.8 5.5 5M14 14.5c3.5-.5 5.6 1 6 4.5"></path></svg>';

    const text = document.createElement('span');
    text.style.textAlign = 'center';
    text.style.fontWeight = '700';
    text.textContent = 'CoBlocks';

    const loader = document.createElement('loader');
    loader.className = 'livescratchloader';
    loader.style.display = 'none';
    button.appendChild(icon);
    button.appendChild(loader);
    button.appendChild(text);
    return button;
}

function createRevertButton(shareButton) {
    const button = document.createElement('livescratch-init');
    button.id = 'lsRevert';
    button.className = copyMatchingClasses(shareButton, [
        'button_outlined-button',
        'menu-bar_menu-bar-button',
        'share-button_share-button',
    ]);
    button.style.marginRight = '7px';
    button.style.marginLeft = '0px';
    button.style.paddingLeft = '7px';
    button.style.paddingRight = '7px';
    button.style.gap = '7px';
    button.style.display = 'flex';
    button.style.flexDirection = 'row';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.whiteSpace = 'nowrap';
    button.style.backgroundColor = 'rgb(255 255 255 / 16%)';
    button.style.color = '#fff';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', 'Revert recent CoBlocks edits');
    button.title = 'Revert recent CoBlocks edits';

    const text = document.createElement('span');
    text.style.textAlign = 'center';
    text.textContent = 'CoBlocks Revert';

    button.appendChild(text);
    return button;
}


function injectCoBlocksAssets() {
    if (!document.querySelector('#lsShareInjectedScript')) {
        const dropdownScriptElem = document.createElement('script');
        dropdownScriptElem.id = 'lsShareInjectedScript';
        dropdownScriptElem.textContent = shareScript;
        document.head.appendChild(dropdownScriptElem);
    }
    injectCoBlocksStyles();
}

function injectCoBlocksStyles() {
    if (!document.querySelector('#lsShareInjectedStyles')) {
        const shareStyles = document.createElement('style');
        shareStyles.id = 'lsShareInjectedStyles';
        shareStyles.textContent = shareCSS;
        document.head.appendChild(shareStyles);
    }
    if (!document.querySelector('#lsSpriteInjectedStyles')) {
        const spriteStyles = document.createElement('style');
        spriteStyles.id = 'lsSpriteInjectedStyles';
        spriteStyles.textContent = spriteDisplayCSS;
        document.head.appendChild(spriteStyles);
    }
}
function creditCollabers(usersList) {
    usersList.map(u => `@${u}`);
    const desc = store.getState().preview.projectInfo.description;
    const prepend = 'Collaborators:';
    const text = `${prepend} @${usersList.join(', ')}`;
    if (desc === '') { setCredits(text); } else if (desc.includes(prepend)) {
        lines = desc.split('\n');
        lines.splice(lines.indexOf(lines.find(e => e.includes(prepend))), 1, text);
        const toset = lines.join('\n');
        setCredits(toset);
    }
}
function setCredits(text) {
    fetch(`https://api.scratch.mit.edu/projects/${scratchId}`, {
        'headers': {
            'accept': 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
            'x-token': store.getState().session.session.user.token,
        },
        'referrer': 'https://scratch.mit.edu/',
        'referrerPolicy': 'strict-origin-when-cross-origin',
        'body': `{\"description\":${JSON.stringify(text)}}`,
        'method': 'PUT',
        'mode': 'cors',
        'credentials': 'omit',
    });
    store.getState().preview.projectInfo.description = text;
}
function addToCredits(text) {
    try {
        const oldDesc = store.getState().preview.projectInfo.description;
        if (oldDesc.includes(text)) { return; }
        const newDesc = oldDesc + (oldDesc === '' ? '' : '\n') + text;

        setCredits(newDesc);
    } catch (e) {
        console.error(e);
    }
}

function showBlStartError(err) {
    const rand = `a${Math.random().toString().substring(2)}`;
    // stop spinny
    document.querySelector('loader.livescratchloader').style.display = 'none';

    document.querySelector('.lsErr')?.remove();
    document.querySelector('livescratchcontainer > livescratch-init').insertAdjacentHTML('afterend', `<div class="${rand} lsErr" style="background:#ffcdf2; outline:3px solid red; padding:4px; position:absolute; top:50px; border-radius:12px; color:red"></div>`);
    document.querySelector('.lsErr').innerText = `There was an error:\n ${err}`;
    setTimeout(() => { document.querySelector(`.lsErr.${rand}`)?.remove(); }, 5000);

}

const lsActivateClick = async () => {

    if (coblocksDisabled) { reloadAfterRestart = true; } //todo write code so that it can do this without restarting
    if (reloadAfterRestart) {
        finishedSavingCB.push(() => { location.reload(); });
        //stop spinny
        document.querySelector('loader.livescratchloader').style.display = 'none';
        reloadOnlineUsers();

        lsShareClick();
    }

    // change onclick
    coblocksButton.onclick = undefined;
    // set spinny icon
    document.querySelector('loader.livescratchloader').style.display = 'flex';

    // save project in scratch
    store.dispatch({ type: 'scratch-gui/project-state/START_MANUAL_UPDATING' });

    await waitFor(() => (!isNaN(parseFloat(location.pathname.split('/')[2]))));
    scratchId = location.pathname.split('/')[2];

    const json = vm.toJSON();

    window.coBlocksRuntime.sendMessage(exId, { json, meta: 'create', scratchId, title: store.getState().preview.projectInfo.title }, async (response) => {
        if (response.noauth || response.err) {
            showBlStartError(response.noauth ? 'CoBlocks has not verified your account yet.' : response.err);
            coblocksButton.onclick = lsActivateClick;
            return;
        }


        lsId = response.id;



        // ACTIVATE LSOKLIVE!!!
        projectReplaceInitiated = true;
        pauseEventHandling = false;
        liveMessage({ meta: 'myId', id: lsId });
        activateCoBlocks();
        // Join the CoBlocks session after the editor is ready.
        liveMessage({ meta: 'joinSession' });
        readyToRecieveChanges = true;
        await refreshShareModal();

        // add livescratch ref in instructions credits
        // addToCredits('Made with BIocklive #blklv')
        creditCollabers(Object.keys(lsShareMembers));

        // stop spinny
        document.querySelector('loader.livescratchloader').style.display = 'none';

        // Set button onclick
        coblocksButton.onclick = lsShareClick;
        reloadOnlineUsers();

        lsShareClick();

    });
};
const lsShareClick = () => {
    const opening = lsDropdown.style.display === 'none';
    lsDropdown.style.display = opening ? 'flex' : 'none';
    coblocksButton.setAttribute('aria-expanded', String(opening));
    if (opening) {
        closeNotificationCenter();
        refreshShareModal();
    }
};

coblocksButton = null;
lsDropdown = null;

function doIOwnThis() {
    return store.getState().session.session.user.id === store.getState().preview.projectInfo.author.id;
}
function addButtonInjectors() {
    listenForObj('button[class*="share-button_share-button"]',
        shareButton => {
            if (document.querySelector('livescratch-init') || !doIOwnThis()) return;

            const container = document.createElement('livescratchContainer');
            container.style.display = 'flex';
            container.style.flexDirection = 'row';
            container.style.alignItems = 'center';
            container.style.position = 'relative';

            const button = createCoBlocksButton(shareButton);
            const notificationsButton = createNotificationsButton(shareButton);
            const notificationsPanel = createNotificationCenter();
            const notificationToast = createNotificationToast();
            coblocksButton = button;
            const dropdown = document.createElement('livescratchDropdown');
            dropdown.innerHTML = shareDropdown;
            dropdown.style.position = 'absolute';
            dropdown.style.top = '44px';
            dropdown.style.right = '10px';
            dropdown.style.zIndex = '1000';
            dropdown.style.display = 'none';
            lsDropdown = dropdown;

            button.onclick = () => {
                if (lsId) lsShareClick();
                else lsActivateClick();
            };
            document.addEventListener('click', event => {
                if (!container.contains(event.target)) {
                    dropdown.style.display = 'none';
                    button.setAttribute('aria-expanded', 'false');
                    closeNotificationCenter();
                }
            });

            container.appendChild(button);
            container.appendChild(notificationsButton);
            container.appendChild(dropdown);
            container.appendChild(notificationsPanel);
            container.appendChild(notificationToast);
            shareButton.parentNode.insertBefore(container, shareButton);

            injectCoBlocksAssets();
            renderNotificationCenter();
            updateNotificationBadge();
            refreshShareModal();
            addRevertButton();
        },
    );

    // Inject active users display
    listenForObj('[class*="menu-bar_account-info-group"]', accountInfo => {
        if (document.querySelector('livescratch-init')) return;
        const topBar = accountInfo.parentElement;

        const panel = document.createElement('div');
        panel.id = 'lsUsersPanel';
        panel.setAttribute('aria-label', 'Online collaborators');
        topBar.insertBefore(panel, accountInfo);
        observeOnlinePanel(panel);
        addChatButton();


        setTopbarButtonVisibility();
        showCachedOnlineUsers();
    });
}


function addRevertButton() {
    const shareButton = document.querySelector('button[class*="share-button_share-button"]');
    const coblocksContainer = coblocksButton?.parentElement;

    if (!lsId || !shareButton || !coblocksContainer || document.querySelector('#lsRevert')) return;

    const button = createRevertButton(shareButton);
    button.onclick = revertProject;
    button.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            button.click();
        }
    };

    coblocksContainer.insertAdjacentElement('afterend', button);

    Array.from(document.querySelectorAll('span')).find(e => e.className.includes('menu-bar_tutorials-label'))?.remove();
}



function revertProject() {
    const conf = window.confirm('CoBlocks Revert:\nThis will delete recent CoBlocks edits and reset the project to the version saved in My Stuff before you opened it.\n\nUse this if CoBlocks damaged the project. You will still need to click Save Now to finalize the revert.\n\nClick OK to revert or Cancel to keep the current version.');
    if (!conf) { return; }

    vm.loadProject(revertJSON);
}

const collaboratorPointers = new Map();
let collaboratorPointersStarted = false;

function removeCollaboratorPointer(username) {
    const key = String(username).toLowerCase();
    collaboratorPointers.get(key)?.element.remove();
    collaboratorPointers.delete(key);
}

function transformPointerPoint(svg, matrix, x, y) {
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    return point.matrixTransform(matrix);
}

function getBlocksPointerContext() {
    if (store?.getState()?.scratchGui?.editorTab?.activeTabIndex !== 0) return null;
    const workspace = BL_UTILS.getWorkspace();
    const svg = workspace?.getParentSvg();
    const matrix = workspace?.getCanvas()?.getScreenCTM();
    const metrics = workspace?.getMetrics();
    const svgMatrix = svg?.getScreenCTM();
    if (!matrix || !svgMatrix || !metrics || metrics.viewWidth <= 0 || metrics.viewHeight <= 0) return null;
    const topLeft = transformPointerPoint(svg, svgMatrix, metrics.absoluteLeft, metrics.absoluteTop);
    const bottomRight = transformPointerPoint(svg, svgMatrix, metrics.absoluteLeft + metrics.viewWidth, metrics.absoluteTop + metrics.viewHeight);
    return { svg, matrix, rect: { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y } };
}

function positionCollaboratorPointer(entry) {
    const pointer = entry.pointer;
    const context = getBlocksPointerContext();
    const targetName = vm?.editingTarget && BL_UTILS.targetToName(vm.editingTarget);
    entry.element.hidden = true;
    if (!context || pointer.space !== 'workspace' || pointer.editorTab !== 0
        || pointer.targetName !== targetName || !lsId || coblocksDisabled || document.hidden) return;
    const { svg, matrix, rect } = context;
    const point = transformPointerPoint(svg, matrix, pointer.x, pointer.y);
    if (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) return;
    const layer = document.getElementById('lsCollaboratorPointers');
    if (layer) layer.style.clipPath = `inset(${Math.max(0, rect.top)}px ${Math.max(0, window.innerWidth - rect.right)}px ${Math.max(0, window.innerHeight - rect.bottom)}px ${Math.max(0, rect.left)}px)`;
    entry.element.hidden = false;
    entry.element.style.transform = `translate(${point.x}px, ${point.y}px)`;
}

function receiveCollaboratorPointer(username, pointer) {
    if (!username || username.toLowerCase() === uname.toLowerCase()) return;
    if (!pointer?.visible) { removeCollaboratorPointer(username); return; }
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return;
    let layer = document.getElementById('lsCollaboratorPointers');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'lsCollaboratorPointers';
        layer.setAttribute('aria-hidden', 'true');
        document.body.appendChild(layer);
    }
    const key = username.toLowerCase();
    let entry = collaboratorPointers.get(key);
    if (!entry) {
        const element = document.createElement('div');
        element.className = 'ls-live-pointer';
        element.style.setProperty('--ls-pointer-color', getCollaboratorColor(username).accent);
        element.innerHTML = '<svg viewBox="0 0 19 24" fill="currentColor"><path d="M2 1 17 15l-7 1-4 6Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
        element.querySelector('span').textContent = username;
        layer.appendChild(element);
        entry = { element };
        collaboratorPointers.set(key, entry);
    }
    entry.pointer = pointer;
    entry.updatedAt = Date.now();
    positionCollaboratorPointer(entry);
}

function startCollaboratorPointers() {
    if (collaboratorPointersStarted) return;
    collaboratorPointersStarted = true;
    let lastEvent = null;
    let timer = null;
    const sendPointer = () => {
        timer = null;
        if (!lsId || coblocksDisabled || !readyToRecieveChanges || !isConnected) return;
        const context = getBlocksPointerContext();
        const hit = lastEvent && document.elementFromPoint(lastEvent.x, lastEvent.y);
        const rect = context?.rect;
        const visible = !!(lastEvent && context && hit && !document.hidden && document.hasFocus()
            && context.svg.contains(hit)
            && !hit.closest('.blocklyFlyout, .blocklyToolboxDiv, .blocklyZoom, .blocklyScrollbarHorizontal, .blocklyScrollbarVertical, .blocklyTrash')
            && lastEvent.x >= rect.left && lastEvent.x <= rect.right
            && lastEvent.y >= rect.top && lastEvent.y <= rect.bottom);
        const pointer = { visible };
        if (visible) {
            const point = transformPointerPoint(context.svg, context.matrix.inverse(), lastEvent.x, lastEvent.y);
            pointer.space = 'workspace';
            pointer.x = point.x;
            pointer.y = point.y;
            pointer.editorTab = 0;
            pointer.targetName = BL_UTILS.targetToName(vm.editingTarget);
        }
        liveMessage({ type: 'pointer', pointer });
    };
    document.addEventListener('pointermove', event => {
        if (!event.isPrimary) return;
        lastEvent = { x: event.clientX, y: event.clientY, target: event.target };
        if (!timer) timer = setTimeout(sendPointer, 50);
    }, { passive: true });
    const hidePointer = () => { lastEvent = null; sendPointer(); };
    document.documentElement.addEventListener('pointerleave', hidePointer);
    window.addEventListener('blur', hidePointer);
    document.addEventListener('visibilitychange', () => { if (document.hidden) hidePointer(); });
    setInterval(() => { if (lastEvent) sendPointer(); }, 2000);
    setInterval(() => {
        for (const [username, entry] of collaboratorPointers) {
            if (Date.now() - entry.updatedAt > 8000) removeCollaboratorPointer(username);
            else positionCollaboratorPointer(entry);
        }
    }, 200);
}

const collaboratorColors = [
    { accent: '#3278b8', background: '#e8f3ff' },
    { accent: '#9460b8', background: '#f3ebfc' },
    { accent: '#24846b', background: '#e5f6ef' },
    { accent: '#bd597c', background: '#fcebf1' },
    { accent: '#a57523', background: '#fff4d6' },
    { accent: '#487e92', background: '#e8f5f8' },
];

function getCollaboratorColor(username) {
    let hash = 0;
    for (const character of String(username).toLowerCase()) {
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return collaboratorColors[hash % collaboratorColors.length];
}

function getOnlineUserLayout(count, width) {
    const cardWidth = (width - Math.max(0, count - 1) * 4) / Math.max(1, count);
    if (cardWidth >= 64) return { avatarsOnly: false, columns: count || 1, avatarSize: 24, dense: false };
    if (cardWidth >= 20) return { avatarsOnly: true, columns: count || 1, avatarSize: Math.min(24, Math.floor(cardWidth - 6)), dense: false };
    const columns = Math.max(1, Math.min(Math.ceil(count / 2), Math.floor((width + 2) / 20)));
    const avatarSize = Math.max(12, Math.min(14, Math.floor((width - (columns - 1) * 2) / columns - 6)));
    return { avatarsOnly: true, columns, avatarSize, dense: true };
}

function layoutOnlineUsers(panel) {
    const cards = panel.querySelector('.ls-online-users');
    if (!cards || !cards.clientWidth) return;
    const layout = getOnlineUserLayout(cards.children.length, cards.clientWidth);
    cards.classList.toggle('is-avatars', layout.avatarsOnly);
    cards.classList.toggle('is-dense', layout.dense);
    cards.style.setProperty('--ls-online-columns', layout.columns);
    cards.style.setProperty('--ls-online-avatar-size', `${layout.avatarSize}px`);
}

let onlinePanelResizeObserver;
function observeOnlinePanel(panel) {
    onlinePanelResizeObserver?.disconnect();
    onlinePanelResizeObserver = new ResizeObserver(() => layoutOnlineUsers(panel));
    onlinePanelResizeObserver.observe(panel);
}

function showOnlineUserTooltip(card, text) {
    let tooltip = document.getElementById('lsOnlineTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'lsOnlineTooltip';
        tooltip.setAttribute('role', 'tooltip');
        document.body.appendChild(tooltip);
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = card.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - tooltip.offsetHeight - 8))}px`;
    card.setAttribute('aria-describedby', tooltip.id);
}

function hideOnlineUserTooltip() {
    const tooltip = document.getElementById('lsOnlineTooltip');
    if (tooltip) tooltip.hidden = true;
}

function clearActive() {
    hideOnlineUserTooltip();
    const panel = document.getElementById('lsUsersPanel');
    if (!panel) return;
    const label = document.createElement('span');
    label.className = 'ls-online-label';
    label.textContent = 'Online';
    const users = document.createElement('div');
    users.className = 'ls-online-users';
    panel.replaceChildren(label, users);
}

let bl_dudes = [];
function displayActive(users) {
    if (!Array.isArray(users)) return;
    bl_dudes.forEach(dude => dude?.remove());
    bl_dudes = [];
    users.forEach(user => {
        if (user.username !== uname) bl_dudes.push(addDude(user.cursor?.targetName, user.username));
    });

    const panel = document.getElementById('lsUsersPanel');
    if (!panel) return;
    setTopbarButtonVisibility();
    panel.querySelector('.ls-online-label').textContent = `Online · ${users.length}`;
    panel.style.setProperty('--ls-online-count', users.length);
    const cards = panel.querySelector('.ls-online-users');

    for (const user of users) {
        const color = getCollaboratorColor(user.username);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'ls-online-user';
        card.style.setProperty('--ls-user-color', color.accent);
        card.style.setProperty('--ls-user-bg', color.background);
        const isMe = user.username.toLowerCase() === uname.toLowerCase();
        const label = `${user.username}${isMe ? ' (you)' : ''}`;
        const tooltipText = user.cursor?.targetName ? `${label} · ${user.cursor.targetName}` : label;
        card.addEventListener('pointerenter', () => showOnlineUserTooltip(card, tooltipText));
        card.addEventListener('pointerleave', hideOnlineUserTooltip);
        card.addEventListener('focus', () => showOnlineUserTooltip(card, tooltipText));
        card.addEventListener('blur', hideOnlineUserTooltip);
        card.addEventListener('keydown', event => {
            if (event.key === 'Escape') hideOnlineUserTooltip();
        });
        card.setAttribute('aria-label', `${label}. View their workspace`);
        card.onclick = () => {
            const cursor = user.cursor;
            if (!cursor) return;
            const target = cursor.targetName ? BL_UTILS.nameToTarget(cursor.targetName) : null;
            if (target) vm.setEditingTarget(target.id);
            const workspace = BL_UTILS.getWorkspace();
            if (Number.isInteger(cursor.editorTab)) store.getState().scratchGui.editorTab.activeTabIndex = cursor.editorTab;
            if (workspace && Number.isFinite(cursor.scale) && Number.isFinite(cursor.scrollX) && Number.isFinite(cursor.scrollY)) {
                if (!workspace.startDragMetrics) workspace.startDragMetrics = workspace.scrollbar?.oldHostMetrics_;
                workspace.setScale(cursor.scale);
                workspace.scroll(cursor.scrollX, cursor.scrollY);
            }
            vm.emitTargetsUpdate();
        };
        const avatar = document.createElement('img');
        avatar.className = 'ls-online-avatar';
        avatar.alt = '';
        if (user.pk) {
            avatar.src = `https://uploads.scratch.mit.edu/get_image/user/${user.pk}_60x60.png`;
        } else {
            getUserInfo(user.username).then(info => { if (info?.pic) avatar.src = info.pic; });
        }
        const name = document.createElement('span');
        name.className = 'ls-online-name';
        name.textContent = isMe ? 'You' : user.username;
        card.append(avatar, name);
        cards.appendChild(card);
    }
    layoutOnlineUsers(panel);
}

lsCursors = null;
function reloadOnlineUsers() {
    window.coBlocksRuntime.sendMessage(exId, { meta: 'getActive', id: lsId }, (res) => {
        if (Array.isArray(res)) updateCollaboratorSummary(res);
        if (JSON.stringify(lsCursors) === JSON.stringify(res)) { return; }
        lsCursors = res;
        clearActive();
        try { displayActive(res); } catch (e) { console.error(e); }
        // moveMyBubble()
    });
}
function showCachedOnlineUsers() {
    clearActive();
    try { displayActive(lsCursors); } catch (e) { console.error(e); }
}

setInterval(reloadOnlineUsers, 2500);
setTimeout(reloadOnlineUsers, 500);


//////////////////// LOADING OVERLAY ////////////////////

const overlayHTML = `
<loading-content>
<img src="${logoUrl}" id="ls-load-logo">
<div class="ls-loading-text">Loading CoBlocks...</div>
</loading-content>
</img>`;
const overlayCSS = `
loading-content{
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-items: center;
    justify-content: center;
    height: 100%;
    scale:70%;
}
livescratch-loading{
    z-index:10000;
    position:fixed;
    width: 100vw;
    height: 100vh;
    /* backdrop-filter: blur(12px); */
    transition: 0.34s;
}
.ls-loading-text{
    animation: .6s ease-in-out 0.3s infinite alternate ls-logo-loading;
    /* animation: name duration timing-function delay iteration-count direction fill-mode; */

    font-family: 'Helvetica Neue','Helvetica',Arial,sans-serif;
    font-style: italic;
    font-weight:500;
    font-size: 40px;
    color:#14264d;

    transition: 0.34s;
    opacity: 0%;


}
#ls-load-logo{
    display: flex;
    animation: .6s ease-in-out infinite alternate ls-logo-loading;
    scale:400%;
    opacity: 0%;
    transition: 0.34s;
    margin-bottom: 10px;
    filter: drop-shadow();
}

@keyframes ls-logo-loading {
    from{
        transform: perspective(400px) rotateX(0deg) rotateY(5deg);
    }
    to{
        transform: perspective(400px) rotateX(0deg) rotateY(-5deg);
    }
}
`;
function finishBLLoadingAnimation() {
    try {
        document.querySelector('livescratch-loading').style.backdropFilter = ' blur(0px)';
        document.querySelector('#ls-load-logo').style.scale = '500%';
        document.querySelector('#ls-load-logo').style.opacity = '0%';
        document.querySelector('.ls-loading-text').style.opacity = '0%';

        setTimeout(() => { document.querySelector('livescratch-loading').style.display = 'none'; }, 601);
    } catch (e) { console.error(e); }
}

function startBLLoadingAnimation() {
    try {
        document.querySelector('livescratch-loading').style.display = 'block';
        document.querySelector('livescratch-loading').style.backdropFilter = ' blur(12px)';
        document.querySelector('#ls-load-logo').style.scale = '80%';
        document.querySelector('#ls-load-logo').style.opacity = '100%';
        document.querySelector('.ls-loading-text').style.opacity = '100%';
    } catch (e) { console.error(e); }
}

function injectLoadingOverlay() {
    try {
        const styleInj = document.createElement('style');
        styleInj.innerHTML = overlayCSS;
        document.head.appendChild(styleInj);

        const loadingOverlay = document.createElement('livescratch-loading');
        loadingOverlay.innerHTML = overlayHTML;
        document.body.appendChild(loadingOverlay);

    } catch (e) { console.error(e); }
}

const editorDarkMode = getComputedStyle(document.documentElement).getPropertyValue('--editorDarkMode-page') !== '';

const chatCss = `
.emojione{
    height: 20px;
    margin-bottom: -3px;
}
.chatdot {
    visibility: hidden;
    position: absolute;
    box-sizing: border-box;
    min-width: 18px;
    height: 18px;
    right: -6px;
    top: -6px;
    padding: 0 4px;
    border: 2px solid #ffe89a;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background-color: #d33b54;
    color: #fff;
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
}

.ls-chat-toggle{
    position: relative;
    box-shadow: 0px 0px 0px 2px #ffffff3d inset;
    color: #14264d;
    font-weight: 800;
    border-radius: 8px;
    display: flex;
    align-items: center;
    height: 70%;
    padding: 0 12px;
    width: max-content;
    background: linear-gradient(120deg, #ffd45c 0%, #ffe89a 100%);
    transition: background 0.3s ease, transform 0.3s ease;
    cursor: pointer;
}
.ls-chat-toggle:hover {
    background: linear-gradient(120deg, #ffe89a 0%, #ffd45c 100%); /* Subtle gradient shift */
    transform: scale(1.05); /* Slightly scale the button for a smooth hover effect */
}
.ls-chat-toggle-button{
    user-select: none;
    display: flex;
    justify-content: center;
    align-items: center;
    width:max-content;
    height:100%;

    margin-left:1em;
}


.mymsg{
    align-self: flex-end;
}
ls-msg-space{height:20px}
ls-msg:not(.mymsg){
    border-top-left-radius: 0;
}
ls-msg.mymsg{
    border-top-right-radius: 0;
}
ls-msg{
    max-height: 220px;
    overflow-y: auto;
    flex-shrink: 0;
    color: ${editorDarkMode ? 'var(--editorDarkMode-accent-text)' : '#000000'};
    border:2px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : 'rgba(0, 0, 0, 0.189)'};
    border-radius: 10px;
    padding: 5px 6px;
    max-width: 80%;
    margin-left: 15px;
    font-size: 18px;
    background-color: ${editorDarkMode ? 'var(--editorDarkMode-input)' : 'rgb(255, 255, 255)'};
    overflow-wrap: anywhere;
}
ls-msg-sender-name{
    font-style:italic;
    color: ${editorDarkMode ? 'var(--editorDarkMode-accent-text)' : 'rgb(73, 73, 73)'};
}
ls-msg-sender:first-of-type{
    margin-top: 1px;
}
ls-msg-sender{
    align-items: center;
    margin-top: 5px;
    display: flex;
    flex-direction: row;
    gap:5px;
}
ls-msg-sender-img{
    background-image: url(https://uploads.scratch.mit.edu/get_image/user/default_60x60.png);
    background-size: contain;
    background-repeat: no-repeat;
    width:25px;
    height:25px;
    border-radius: 10px;
}

ls-chat-send-button{
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    display: flex;
    user-select: none;
    width: 40px;
    height: 100%;
    min-height: 40px;
    background-color: #14264d;
    color:white;
    text-align: center;
    border-left: 1px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : '#dcdee0'};

    transition: 0.2s scale;
}
ls-chat-send-button:hover{
    scale: 112%;
}
ls-chat-send{
    max-height: 150px;
    min-height: 40px;
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    align-items: center;
    border-radius: 8px;
    border-top-right-radius: 0;
    border: 1px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : '#d9d9d9'};
    margin: 10px;
    margin-top: 0;
    box-shadow: 0px -2px 5px 0px #0000001a;
    overflow: clip;
}

ls-chat-input{
    flex-grow: 1;
    max-height:150px;
    min-height:40px;
    overflow-y: auto;
    text-overflow: clip;
    overflow-wrap: anywhere;


    font-size:17px;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    padding:10px;
    background-color: ${editorDarkMode ? 'var(--editorDarkMode-input)' : 'white'};

    /* text-align: center; */
}
ls-chat-input:focus{
    outline: none;
}

ls-chat-msgs{
    display: flex;
    flex-shrink:1;
    flex-direction: column;
    padding:10px;
    overflow-y: scroll;
    /* height:400px; */
    flex-grow:1;

    /* min-height: 15px; */
    /* width: 100%; */
    padding-top:5px;
    font-family: Tahoma, sans-serif;
    font-size: 20px;
    line-height: 20px;
    color:rgb(38, 38, 38);
    gap:3px;
    align-items: flex-start;
}
ls-chat-msgs::-webkit-scrollbar { width: 0 !important }
ls-chat-msgs { overflow: -moz-scrollbars-none; }

ls-chat-head-button{
    cursor:pointer;

    border-radius: 100%;
    padding:4px;
    width:25px;
    height:25px;
    text-align: center;
    background-color: #14264d;
    transition: 0.2s scale;

    display: flex;
    align-items: center;
    justify-content: center;
}
ls-chat-head-button:not(:last-of-type) {
    margin-right: 5px;
}
ls-chat-head-button:hover{
    scale: 112%;
}
ls-chat-head-filler{
    display: flex;
    flex-grow:1;
}
ls-chat-head-text{
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-weight: bold;
    font-size: 20px;
    color:white;
    margin-right: 5px;
}
ls-chat-head {
    user-select: none;
    display: flex;
    flex-direction: row;
    align-items: center;
    width: 100%;
    height:45px;
    flex-shrink:0;
    /* min-height:45px; */
    background-color: #14264d;
    border-radius: 8px;
    padding-inline: 11px;
    box-shadow: 0px 0px 6px 0px rgba(0,0,0,0.5);
    z-index: 50;
}

ls-chat{
    border-radius: 8px;

    display:flex;
    max-width: 300px;
    min-width: 250px;
    height:auto;
    flex-direction: column;

    margin-left: 0.5rem;
    margin-top: 2.75rem;
    border-bottom: 0;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;

    background-color: ${editorDarkMode ? 'var(--editorDarkMode-accent)' : '#fff'};
    border: 1px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : '#c6cdd6'};

    box-sizing: border-box;

    overflow: clip;

}
ls-chat.popout ls-chat-head{
    cursor: move;
}
ls-chat.popout{
    margin: 0;
    border-radius: 8px;
    box-shadow: 2px 2px 11px #0000003b;
    position: absolute;

    min-height: 280px;
    max-height: 700px;
    max-width: 600px;

    width: 300px;
    height: 500px;

    left: 250px;
    top: 70px;
    resize: both;
    overflow: auto;

    z-index: 1000;
}
ls-chat:not(.popout){
    width: auto !important;
    height: auto !important;
}

/* CoBlocks chat refresh */
ls-chat { border-radius: 14px; min-width: 270px; border: 1px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : '#d9e1ef'}; box-shadow: 0 10px 30px rgba(20,38,77,.12); }
ls-chat-head { min-height: 54px; height: 54px; padding: 8px 10px; border-radius: 13px 13px 10px 10px; background: linear-gradient(120deg,#fffdf7,#ffd86b); box-shadow: inset 0 2px 0 rgba(255,255,255,.38); }
ls-chat-head #logo { width: 34px; height: 34px !important; padding: 3px; margin-right: 8px !important; border-radius: 9px; background: rgba(255,255,255,.92); object-fit: contain; }
ls-chat-head-text { display: flex; flex-direction: column; color: #14264d; font-size: 16px; line-height: 18px; }
ls-chat-head-button { width: 30px; height: 30px; padding: 6px; border-radius: 9px; background: rgba(20,38,77,.72) !important; }
ls-chat-head-button:hover { scale: 1; background: rgba(20,38,77,.86) !important; }
ls-chat-msgs { gap: 7px; padding: 14px 12px; font-family: "Helvetica Neue",Helvetica,Arial,sans-serif; font-size: 14px; line-height: 18px; scrollbar-width: thin; }
ls-msg-space { height: 2px; }
ls-msg-sender { gap: 7px; margin: 7px 0 0; }
ls-msg-sender.mymsg { flex-direction: row-reverse; }
ls-msg-sender-img { width: 28px; height: 28px; border-radius: 9px; background-size: cover; background-position: center; }
ls-msg-sender-name { color: ${editorDarkMode ? 'var(--editorDarkMode-accent-text)' : '#60708c'}; font-size: 12px; font-style: normal; font-weight: 700; }
ls-msg { max-width: 82%; margin: 0; padding: 8px 10px; border: 0; border-radius: 12px 12px 12px 4px; color: ${editorDarkMode ? 'var(--editorDarkMode-accent-text)' : '#1f2b45'}; background: ${editorDarkMode ? 'var(--editorDarkMode-input)' : '#f1f4f9'}; font-size: 14px; line-height: 18px; box-shadow: none; }
ls-msg.mymsg { border-radius: 12px 12px 4px 12px; color: #14264d; background: linear-gradient(120deg,#dce6f7,#b9cae8); }
ls-chat-send { min-height: 46px; margin: 8px 10px 10px; border: 1px solid ${editorDarkMode ? 'var(--editorDarkMode-border)' : '#cbd5e7'}; border-radius: 11px; box-shadow: 0 3px 12px rgba(20,38,77,.08); background: ${editorDarkMode ? 'var(--editorDarkMode-input)' : '#fff'}; }
ls-chat-input { min-width: 0; min-height: 44px; padding: 11px 12px; font-size: 14px; line-height: 20px; background: transparent; }
ls-chat-input:empty::before { content: attr(data-placeholder); color: #86938d; pointer-events: none; }
ls-chat-send-button { width: 44px; min-height: 44px; border: 0; border-radius: 0 10px 10px 0; background: linear-gradient(135deg,#7188b4,#8fa4cb); cursor: pointer; }
ls-chat-send-button:hover { scale: 1; filter: brightness(1.08); }
ls-chat.popout { min-width: 300px; min-height: 320px; border-radius: 14px; box-shadow: 0 18px 50px rgba(22,45,36,.28); }
`;

function injectChatCSS() {
    try {
        const styleInj = document.createElement('style');
        styleInj.innerHTML = chatCss;
        document.head.appendChild(styleInj);
    } catch (e) { console.error(e); }
}

function injectEmojiOne() {
    try {
        const linkStylesheet = document.createElement('link');
        linkStylesheet.rel = 'stylesheet';
        linkStylesheet.href = 'https://cdnjs.cloudflare.com/ajax/libs/emojione/4.5.0/assets/css/emojione.min.css';

        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/emojione/4.5.0/lib/js/emojione.min.js';

        document.head.appendChild(linkStylesheet);
        document.head.appendChild(script);
    } catch (e) { console.error(e); }
}

function addChat() {
    try {
        injectChatCSS();
        injectEmojiOne();

        const lsChat = document.createElement('ls-chat');
        lsChat.id = 'ls-chat';
        lsChat.innerHTML = ChatHTML;
        // lsChat.style.visibility = 'hidden'
        const parentContainer = document.body.querySelector('#app').querySelector('.box_box_bP3Aq').querySelector('.gui_flex-wrapper_Zk207');
        parentContainer.insertBefore(lsChat, parentContainer.childNodes[1]);

        const chatbox = document.querySelector('ls-chat');

        document.querySelector('ls-chat-input').addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                postMessageBubble();
                event.preventDefault();
            }
        });
        document.querySelector('ls-chat-send-button').onclick = postMessageBubble;
        chatbox.style.display = 'none';

        //// get own username, then populate chat history
        window.coBlocksRuntime.sendMessage(exId, { meta: 'getUsernamePlus' }, (userData) => {
            uname = userData.uname;
            const token = userData.currentCoBlocksToken;
            fetch(apiUrl + '/chat/' + lsId, { headers: { uname, authorization: token } }).then(async res => {
                const chatHistory = await res.json();
                chatHistory.forEach(msg => addMessage(msg));
            });
        });
        backspaceFix();

        chatbox.querySelector('#popout').onclick = () => togglePopout(false);

        const observer = new ResizeObserver(() => {
            document.querySelector('ls-chat-head').querySelector('#logo').style.display = 'initial';
            if (document.querySelector('ls-chat-head-text').clientHeight > 23) {
                document.querySelector('ls-chat-head').querySelector('#logo').style.display = 'none';
            } else {
                document.querySelector('ls-chat-head').querySelector('#logo').style.display = 'initial';
            }
        });

        observer.observe(document.querySelector('ls-chat-head'));
    } catch (e) { console.error(e); }
}
function addChatButton() {
    try {
        const chatElem = document.createElement('div');
        chatElem.id = 'lsChatButton';
        chatElem.classList.add('ls-chat-toggle-button');
        chatElem.innerHTML = '<span class="ls-chat-toggle" onclick="toggleChat()"><span>💬 CoBlocks Chat</span><span class="chatdot"></span></span>';

        const tab_list = document.querySelector('.gui_tab-list_VOr4n');
        tab_list.appendChild(chatElem);

        setChatUnread(chatUnreadCount);

        if (!lsId) { chatElem.style.visibility = 'hidden'; chatElem.style.display = 'none'; } else { chatElem.style.visibility = 'visible'; chatElem.style.display = 'flex'; }

    } catch (e) { console.error(e); }
}
let chatUnreadCount = 0;
function incChatUnread() {
    setChatUnread(chatUnreadCount + 1);
}
function setChatUnread(num) {
    chatUnreadCount = num;
    const chatdot = document.querySelector('.chatdot');
    if (!chatdot) return;
    chatdot.textContent = num > 99 ? '99+' : String(num);
    chatdot.style.visibility = num === 0 ? 'hidden' : 'visible';
}

const ChatHTML = `
<ls-chat-head id="ls-chat-banner">
    <img id="logo" src="${logoUrl}" style="height: 25px; margin-right: 5px;">
    <ls-chat-head-text>CoBlocks Chat</ls-chat-head-text>
    <ls-chat-head-filler></ls-chat-head-filler>
    <ls-chat-head-button id="popout" style="background-color: #1d376b;">
        <img src="data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224px%22%20viewBox%3D%220%20-960%20960%20960%22%20width%3D%2224px%22%20fill%3D%22%23FFFFFF%22%3E%3Cpath%20d%3D%22M80.09-80.09v-799.82h412.13v122.95H203.04v553.92h553.92v-289.18h122.95v412.13H80.09Zm323.56-238.26-85.3-85.3%20353.3-353.31h-99.43v-122.95h307.69v307.69H756.96v-99.43l-353.31%20353.3Z%22%2F%3E%3C%2Fsvg%3E" style="height: 100%;">
    </ls-chat-head-button>
    <ls-chat-head-button onclick="toggleChat(false)">
        <img src="data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224px%22%20viewBox%3D%220%20-960%20960%20960%22%20width%3D%2224px%22%20fill%3D%22%23FFFFFF%22%3E%3Cpath%20d%3D%22m254-159-94-95%20225-226-225-226%2094-96%20226%20226%20226-226%2094%2096-225%20226%20225%20226-94%2095-226-226-226%20226Z%22%2F%3E%3C%2Fsvg%3E" style="height: 100%;">
    </ls-chat-head-button>
</ls-chat-head>
<ls-chat-msgs>
    <ls-msg-space></ls-msg-space>
</ls-chat-msgs>
<ls-chat-send>
    <ls-chat-input contenteditable="true" role="textbox" aria-label="Chat message" data-placeholder="Write a message..."></ls-chat-input>
    <ls-chat-send-button><img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' height='24px' viewBox='0 -960 960 960' width='24px' fill='%23FFFFFF'%3E%3Cpath d='M176-183q-20 8-38-3.5T120-220v-180l320-80-320-80v-180q0-22 18-33.5t38-3.5l616 260q25 11 25 37t-25 37L176-183Z'/%3E%3C/svg%3E" style="height: auto; flex-grow: 0;"></ls-chat-send-button>
</ls-chat-send>`;


// msg: {text, sender}
lastSender = '';
uname = '';
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

async function addMessage(msg, notif) {
    const msgsElem = document.querySelector('ls-chat-msgs');
    if (msg.sender !== lastSender) {
        const unameElem = document.createElement('ls-msg-sender');
        unameElem.innerHTML = `
        <ls-msg-sender-img></ls-msg-sender-img>
        <ls-msg-sender-name>${sanitize(msg.sender)}</ls-msg-sender-name>`;
        lastSender = msg.sender;
        if (msg.sender === uname) { unameElem.classList.add('mymsg'); }
        msgsElem.appendChild(unameElem);

        { (async() => { unameElem.querySelector('ls-msg-sender-img').style.backgroundImage = `url(${(await getUserInfo(msg.sender)).pic})`; })(); }
    }
    const msgElem = document.createElement('ls-msg');
    msgElem.innerText = msg.text;

    if (msg.linkify) {
        const newHTML = msgElem.innerHTML.replace(/(<a href=")?((https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)))(">(.*)<\/a>)?/gi, function () {
            return '<a target="_blank" href="' + arguments[2] + '">' + (arguments[7] || arguments[2]) + '</a>';
        });
        msgElem.innerHTML = newHTML;
    }

    if (msg.sender === uname) { msgElem.classList.add('mymsg'); }

    const emojiWhitelist = [
        ':smiley:', // 😃
        ':sob:', // 😭
        ':skull:', // 💀
        ':laughing:', // 😆
        ':rofl:', // 🤣
        ':joy:', // 😂
        ':stuck_out_tongue_closed_eyes:', // 😝
        ':stuck_out_tongue_winking_eye:', // 😜
        ':cry:', // 😢
        ':sunglasses:', // 😎
        ':thumbsup:', // 👍
        ':thumbsdown:', // 👎
        ':neutral_face:', // 😐
        ':exploding_head:', // 🤯
        ':fire:', // 🔥
        ':white_check_mark:', // ✅
        ':pray:', // 🙏
        ':x:', // ❌
        ':confused:', // 😕
        ':question:', // ❓
        ':scream:', // 😱
        ':smirk:', // 😏
        ':bangbang:', // ‼️
        ':moyai:', // 🗿
        ':nerd:', // 🤓
        ':waakul:', // https://cdn2.scratch.mit.edu/get_image/user/128606483_60x60.png Custom Emoji
        ':coblocks:', // CoBlocks custom emoji
        ':livescratch:', // Legacy alias
    ];

    const customEmojis = {
        ':waakul:': 'https://cdn2.scratch.mit.edu/get_image/user/128606483_60x60.png',
        ':coblocks:': logoUrl,
        ':livescratch:': logoUrl,
    };

    let content = msgElem.innerHTML;

    function convertWhitelistedEmojis(content) {
        let transformedContent = content.replace(/:([a-zA-Z0-9_+-]+):/g, (match) => {
            if (emojiWhitelist.includes(match)) {
                if (customEmojis[match]) {
                    // Render custom emojis with customEmojis mapping
                    return `<img src="${customEmojis[match]}" alt="${match}" class="emojione" style="height:20px;">`;
                }
                // Render standard emojis with EmojiOne
                return emojione.shortnameToImage(match);
            }
            return match; // Return the original text if not whitelisted
        });

        // Check if the content consists only of <img> tags and optional spaces
        if (/^(\s*<img [^>]+>\s*)+$/.test(transformedContent)) {
            transformedContent = transformedContent.replace(/style="height:20px;"/g, 'style="height:30px;"');
        }

        return transformedContent;
    }

    content = convertWhitelistedEmojis(content);

    msgElem.innerHTML = content;

    msgsElem.appendChild(msgElem);

    msgsElem.scrollTop = msgsElem.scrollHeight;


    if (notif) {
        addCoBlocksNotification({
            type: 'chat',
            title: `@${msg.sender}`,
            message: msg.text,
            action: 'chat',
        });
        if (!isChatOpen()) {
            incChatUnread();
        }
        if (!isChatOpen() || !document.hasFocus()) {
            liveMessage({ meta: 'chatnotif', project: store.getState().preview.projectInfo.title, sender: msg.sender, text: msg.text, avatar: (await getUserInfo(msg.sender)).pic });
        }
    }
}

function isPingEnabled() {
    return new Promise(ret =>
        window.coBlocksRuntime.sendMessage(exId, { meta: 'isPingEnabled' }, enabled => {
            ret(!window.coBlocksRuntime.lastError && enabled === true);
        }),
    );
}
function playSound(url) {
    const a = new Audio(url);
    a.play().catch(() => {}); // Browsers may block audio until the user interacts with the page.
}

function postMessageBubble() {
    const inputElem = document.querySelector('ls-chat-input');
    let messageText = inputElem.innerText;
    messageText = messageText.trim();
    if (messageText === '') { return; }


    const messageObj = { sender: uname, text: messageText };
    addMessage(messageObj);
    liveMessage({ meta: 'chat', msg: messageObj });

    inputElem.innerText = '';
}

function togglePopout(state) {
    const chatbox = document.querySelector('ls-chat');
    const popoutBtn = chatbox.querySelector('#popout');

    const popoutSrc = 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224px%22%20viewBox%3D%220%20-960%20960%20960%22%20width%3D%2224px%22%20fill%3D%22%23FFFFFF%22%3E%3Cpath%20d%3D%22M80.09-80.09v-799.82h412.13v122.95H203.04v553.92h553.92v-289.18h122.95v412.13H80.09Zm323.56-238.26-85.3-85.3%20353.3-353.31h-99.43v-122.95h307.69v307.69H756.96v-99.43l-353.31%20353.3Z%22%2F%3E%3C%2Fsvg%3E';
    const extendSrc = 'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20height%3D%2224px%22%20viewBox%3D%220%20-960%20960%20960%22%20width%3D%2224px%22%20fill%3D%22%23FFFFFF%22%3E%3Cpath%20d%3D%22M178.52-178.52v-282.96h122.96v160h160v122.96H178.52Zm480-320v-160h-160v-122.96h282.96v282.96H658.52Z%22%2F%3E%3C%2Fsvg%3E';

    if (state) {
        rmChatDrag();
        chatbox.classList.remove('popout');
        popoutBtn.querySelector('img').src = popoutSrc;
    } else {
        chatbox.classList.add('popout');
        popoutBtn.querySelector('img').src = extendSrc;

        chatDrag();
    }
    popoutBtn.onclick = () => togglePopout(!state);
    refreshScratchLayout();
}

function rmChatDrag() {
    document.querySelector('ls-chat.popout').querySelector('ls-chat-head').onmousedown = null;
}

function chatDrag() {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    document.querySelector('ls-chat.popout').querySelector('ls-chat-head').onmousedown = dragMouseDown;

    function dragMouseDown(e) {
        e = e || window.event;
        e.preventDefault();
        // get the mouse cursor position at startup:
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        // call a function whenever the cursor moves:
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e = e || window.event;
        e.preventDefault();
        // calculate the new cursor position:
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        // set the element's new position:
        const elmnt = document.querySelector('ls-chat.popout');
        elmnt.style.top = (elmnt.offsetTop - pos2) + 'px';
        elmnt.style.left = (elmnt.offsetLeft - pos1) + 'px';
    }

    function closeDragElement() {
        // stop moving when mouse button is released:
        document.onmouseup = null;
        document.onmousemove = null;
    }
}

function toggleChat(state) {
    const chatbox = document.querySelector('ls-chat');
    if (state === undefined) {
        // chatbox.style.visibility = chatbox.style.visibility==='hidden' ? 'visible' : 'hidden'
        if (chatbox.style.display === 'flex') {
            chatbox.style.display = 'none';
        } else {
            chatbox.style.display = 'flex';
        }
        // chatbox.style.scale = chatbox.style.transformOrigin='top left'
    } else {
        // chatbox.style.visibility = state ? 'visible' : 'hidden'
        if (state) {
            chatbox.style.display = 'flex';
        } else {
            chatbox.style.display = 'none';
        }
        // chatbox.style.scale = chatbox.style.transformOrigin='center'
    }
    if (isChatOpen()) {
        setChatUnread(0);
        coBlocksNotifications.forEach(notification => {
            if (notification.type === 'chat') notification.unread = false;
        });
        updateNotificationBadge();
    }
    refreshScratchLayout();
}
function isChatOpen() {
    const chatbox = document.querySelector('ls-chat');
    return !!chatbox && getComputedStyle(chatbox).display !== 'none';
}

function refreshScratchLayout() {
    const resize = () => {
        window.dispatchEvent(new Event('resize'));
        try {
            const workspace = typeof BL_UTILS !== 'undefined' ? BL_UTILS.getWorkspace?.() : null;
            if (workspace && typeof Blockly !== 'undefined' && typeof Blockly.svgResize === 'function') Blockly.svgResize(workspace);
        } catch (error) {
        }
    };
    requestAnimationFrame(() => {
        resize();
        requestAnimationFrame(resize);
    });
    setTimeout(resize, 160);
}


function getSpriteBoxElem(spriteName) {
    const elem = Array.from(document.querySelectorAll('[class*=sprite-selector_scroll]')[0].querySelectorAll('div')).find(elem => elem.innerHTML === spriteName);
    return elem?.parentElement?.parentElement;
}
function addDude(spritename, dudename) {
    let spriteBox = getSpriteBoxElem(spritename);
    if (spritename === BL_UTILS.stageName) { spriteBox = document.querySelector('[class*=stage-selector_stage-selector]'); }
    if (!spriteBox) { return; }
    let panel = spriteBox?.querySelector('.sdPanel');
    if (!panel) {
        // add sd panel
        panel = document.createElement('div');
        panel.classList.add('sdPanel');
        spriteBox.appendChild(panel);
    }
    const dude = document.createElement('div');
    dude.classList.add('sdCircle');
    dude.style.outlineColor = getCollaboratorColor(dudename).accent;
    dude.title = dudename;
    panel.appendChild(dude);
    getUserInfo(dudename).then(info => dude.style.backgroundImage = `url(${info.pic})`);

    return dude;
}

const spriteDisplayCSS = `
.sdPanel{
    display:flex;
    flex-wrap:wrap;
    flex-direction:row;
    width:70%;
    position:absolute;
    left:3px;
    top:3px;
    gap:-1px;
}
.sdCircle{
    width:20px;
    height:20px;
    border-radius:100%;
    outline: solid 2px #58c198;
    background-size:cover;
}
`;

function moveMyBubble() {
    try {
        lsCursors.find(b => b.username === uname).cursor.targetName = BL_UTILS.targetToName(vm.editingTarget);
        clearActive();
        try { displayActive(lsCursors); } catch (e) { console.error(e); }
    } catch (e) { console.error(e); }
}

function backspaceFix() {
    document.querySelector('#ls-chat > ls-chat-send > ls-chat-input').addEventListener('keydown', (e) => {
        e.stopPropagation();
    });
    document.addEventListener('mousedown', e => {
        if (e.target !== document.querySelector('#ls-chat > ls-chat-send > ls-chat-input') &&
            document.activeElement === document.querySelector('#ls-chat > ls-chat-send > ls-chat-input')) {
            document.activeElement.blur();
        }
    });
}


///////// revert projects /////////
