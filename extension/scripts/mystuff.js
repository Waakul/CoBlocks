
// get exId
const exId = document.querySelector('.livescratch-ext').dataset.exId;

////////// INJECT UTILS //////////

const queryList = [];
function mutationCallback() {
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




// LSM!!!!
function getBlMyStuff() {
    return new Promise((promRes) => {
        chrome.runtime.sendMessage(exId, { meta: 'myStuff' }, promRes);
    });
}

function leaveId(id, div) {
    if (id in lsProjectDivs) {
        document.querySelector('#main-content > div.media-list > ul').insertBefore(lsProjectDivs[id], div);
    }
    div.remove();
}

function sendLeave(scratchId, lsId) {
    const index = lsMySTuff.findIndex(item => String(item.scratchId) === String(scratchId));
    if (index !== -1) lsMySTuff.splice(index, 1);
    if (lsId) {
        chrome.runtime.sendMessage(exId, { meta: 'leaveLSId', lsId });
    } else {
        chrome.runtime.sendMessage(exId, { meta: 'leaveScratchId', scratchId });
    }
}

function sanitize(string) {
    string = String(string);
    // if(!(_.isString(string))) {return ''}
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

function validScratchUsername(username) {
    return typeof username === 'string' && /^[a-zA-Z0-9_-]{3,20}$/.test(username);
}

function getbox(lsId, title, scratchId, lastModified, lastModBy, projectExists, online) {
    scratchId = sanitize(scratchId);
    title = sanitize(title);
    lsId = sanitize(lsId);
    lastModBy = sanitize(lastModBy);

    const gunkId = Math.random().toString(36).substring(2);
    generateActiveUsersPanel(online).then(panel => {
        const container = document.getElementById(gunkId);
        if (container) container.innerHTML = panel;
    });

    return `
    <div class="media-item-content not-shared">
      <div class="media-thumb">
        <a href="/projects/${scratchId}/">
          <img src="//cdn2.scratch.mit.edu/get_image/project/${scratchId}_100x80.png">
        </a>
      </div>
      <div class="media-info">
        <span class="media-info-item title"><a style="color:rgb(88, 193, 152)" href="/projects/${scratchId}/">${title}</a></span>
      	<span class="media-info-item date shortDateFormat">
        
          Last modified: ${timeSince(new Date(lastModified))} ago by ${lastModBy}
          
        </span>
      <div class="seeInsideContainer">

      <a href="/projects/${scratchId}/#editor" data-control="edit" class="media-control-edit small button grey">
	     
      <span>See inside</span>
      <div class="activeContainer" id="${gunkId}"></div>

      </a>

        </div>

      </div>
      <div class="media-action">
		      <div><a class="media-trash" style="color:rgb(88, 193, 152)">${projectExists ? 'Unlink' : 'Leave'}</a></div>
      </div>
    </div>`;
}


async function generateActiveUsersPanel(active) {
    const safeUsers = Array.isArray(active) ? active.filter(validScratchUsername) : [];
    if (safeUsers.length > 0) {
        safeUsers.forEach(username => getUserInfo(username).then(info => {
            if (!info?.pic) return;
            document.querySelectorAll(`.${username}`).forEach(elem => elem.style.backgroundImage = `url(${info.pic})`);
        }));
        return `
      <div class="activeContainer">

        ${safeUsers.map(username =>
        `<div class="onlineBubble ${username}" style="background-color: white; --bubbleUsername:'${sanitize(username)}'"></div>`,
    )
        .join('\n')}
     
          
       

        
            
      </div>
    `;

    } else {
        return '';
    }
}

const pageCss = `

  .onlineBubble{
    height:26px;
    width:26px;
    outline:solid 3px rgb(88, 193, 152);
    border-radius:10px;
    background-size:100% auto;
    text-shadow:none;

    margin-right:8px;

  }
    .onlineBubble::after{
      background:black;
      width:100px;
      height:30px;
      padding-top:0;
      padding-bottom:0;
      translate: -25% 0;
    }

.onlineBubble:hover::after {
    opacity: 100%;
}

.onlineBubble::after {
    content: var(--bubbleUsername);
    background: rgb(88, 193, 152);
    color: white;
    padding: 0 6px;
    border-radius: 5px;
    transform: translate(0px, -23px);
    display: inline-block;
    width: fit-content;
    height: fit-content;
    opacity: 0%;
    transition: 0.2s opacity;

}


  .seeInsideContainer, .activeContainer{
    display:flex;
    flex-flow:row;
    align-items:flex-end;
    // gap:8px;
  }

   .activeContainer{
   align-items:center;
   }

   .tailText{
    color:grey
   }


  .media-control-edit{
  display:flex !important;
  flex-flow:row;
  align-items:center;
  flex-grow:0;
width:fit-content;

  }

  .media-info-item.date.shortDateFormat{
      width:200%;
  }

  .ls-project-row > .media-item-content {
      margin-block: 8px;
      padding: 12px;
      border: 1px solid rgba(66,167,126,.22);
      border-left: 5px solid #4caf86;
      border-radius: 14px;
      background: linear-gradient(100deg,rgba(235,250,244,.78),rgba(235,244,255,.55));
      box-shadow: 0 7px 24px rgba(31,74,56,.08);
  }
  .ls-project-row .media-thumb img { border-radius: 10px; }
  .ls-project-row .media-info-item.title a { color: #14264d !important; font-weight: 700; }
  .ls-project-row .media-info-item.date { color: #66756e; }
  .ls-project-row .media-control-edit { min-height: 34px; padding-inline: 12px; border: 1px solid rgba(224,168,27,.28); border-radius: 9px; color: #14264d; background: linear-gradient(120deg,#ffd45c,#ffe89a); }
  .ls-project-row .media-trash { display: inline-flex; padding: 7px 10px; border-radius: 8px; color: #a54242 !important; background: #fff0f0; font-weight: 700; }
  .ls-project-row .onlineBubble { width: 24px; height: 24px; margin-left: -4px; margin-right: 0; border-radius: 50%; outline: 2px solid #fff; }
`;


function injectStyle() {
    const style = document.createElement('style');
    style.textContent = pageCss;
    document.head.append(style);
}
injectStyle();


// https://stackoverflow.com/questions/3177836/how-to-format-time-since-xxx-e-g-4-minutes-ago-similar-to-stack-exchange-site
function timeSince(date) {

    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 0) { return 'zero seconds'; }

    let interval = seconds / 31536000;

    if (interval > 1) {
        return Math.floor(interval) + ' years';
    }
    interval = seconds / 2592000;
    if (interval > 1) {
        return Math.floor(interval) + ' months';
    }
    interval = seconds / 86400;
    if (interval > 1) {
        return Math.floor(interval) + ' days';
    }
    interval = seconds / 3600;
    if (interval > 1) {
        return Math.floor(interval) + ' hours';
    }
    interval = seconds / 60;
    if (interval > 1) {
        return Math.floor(interval) + ' minutes';
    }
    return Math.floor(seconds) + ' seconds';
}

function getId(listItem) {
    return listItem.children[0].children[0].children[0].getAttribute('href').split('/')[2];
}


const oldAttrs = {};
async function convertToCoBlocks(listItem, projectObj) {
    listItem.classList.add('ls-project-row');
    const atts = {};
    atts.color = listItem.children[0].children[1].children[0].children[0].style.color;
    listItem.children[0].children[1].children[0].children[0].style.color = 'rgb(88, 193, 152)';
    listItem.children[0].children[2].children[0].children[0].style.color = 'rgb(88, 193, 152)';

    atts.buttonText = listItem.children[0].children[2].children[0].children[0].innerText;
    listItem.children[0].children[2].children[0].children[0].innerText = 'Unlink';
    listItem.children[0].children[2].children[0].children[0].onclick = (e) => { removeCoBlocksProjectState(projectObj.scratchId, listItem); sendLeave(projectObj.scratchId, projectObj.lsId); e.stopPropagation(); };
    atts.title = listItem.children[0].children[1].children[0].children[0].innerText;
    listItem.children[0].children[1].children[0].children[0].innerText = projectObj.title;

    atts.modified = listItem.children[0].children[1].children[1].innerText;
    listItem.children[0].children[1].children[1].innerText = `Last modified: ${timeSince(new Date(projectObj.lastTime))} ago by ${projectObj.lastUser}`;

    oldAttrs[projectObj.scratchId] = atts;

    const seeInside = listItem.querySelector('a span');
    const activeUsersPanel = await generateActiveUsersPanel(projectObj.online);
    seeInside.insertAdjacentHTML('afterend', activeUsersPanel);


}
function removeCoBlocksProjectState(scratchId, listItem) {
    const atts = oldAttrs[scratchId];
    if (!atts) { return; }
    listItem.children[0].children[1].children[0].children[0].style.color = atts.color;
    listItem.children[0].children[2].children[0].children[0].style.color = atts.color;
    listItem.children[0].children[2].children[0].children[0].innerText = atts.buttonText;
    // listItem.children[0].children[2].children[0].children[0].onclick = ()=>{alert('yi')}
    listItem.children[0].children[1].children[0].children[0].innerText = atts.title;
    listItem.children[0].children[1].children[1].innerText = atts.modified;
    listItem.classList.remove('ls-project-row');
}

function addProject(projectObj, projectExists) {
    const newBox = document.createElement('li');
    newBox.className = 'ls-project-row';
    newBox.innerHTML = getbox(projectObj.lsId, projectObj.title, projectObj.scratchId, projectObj.lastTime, projectObj.lastUser, projectExists, projectObj.online);
    newBox.querySelector('.media-trash')?.addEventListener('click', () => {
        leaveId(projectObj.scratchId, newBox);
        sendLeave(projectObj.scratchId, projectObj.lsId);
    });
    document.querySelector('ul.media-list').insertBefore(newBox, document.querySelector('ul.media-list').firstChild);
}

usersCache = {};

async function getUserInfo(username) {
    if (!validScratchUsername(username)) { return null; }
    if (username?.toLowerCase() in usersCache && usersCache[username?.toLowerCase()]?.pk) { return usersCache[username?.toLowerCase()]; }

    let res;
    try {
        res = await (await fetch('https://scratch.mit.edu/site-api/users/all/' + username?.toLowerCase())).json();
    } catch (e) {
        return null;
    }
    if (!res) {
        return null;
    }

    let user = res.user;
    user = getWithPic(user);
    usersCache[user.username.toLowerCase()] = user;
    return user;
}
function getWithPic(user) {
    user.pic = `https://uploads.scratch.mit.edu/get_image/user/${user.pk}_60x60.png`;
    return user;
}


////////// RUN ON START! ///////////

let lsMySTuff;
let lsMyStuffMap = {};
const lsProjectDivs = {};
let projectLoadFailed = false;
async function onTabLoad() {
    lsMySTuff = await getBlMyStuff();
    if (lsMySTuff?.noauth) { projectLoadFailed = true; return false; }
    listenForObj('ul.media-list', (list) => {
        if (!document.querySelector('#tabs > li.first.active')) { return; } // return if "all projects" not selected
        lsMyStuffMap = {};
        lsMySTuff.forEach(projObj => { lsMyStuffMap[projObj.scratchId] = projObj; });
        const toDelete = [];
        for (const child of list.children) {
            const scratchId = getId(child);
            const coblocksProject = lsMyStuffMap[scratchId];
            if (coblocksProject) {
                if (Date.now() - coblocksProject.lastTime < 1000 * 60 * 60 * 2) { // if project was edited less than 2 hours ago
                    toDelete.push(child);
                    lsProjectDivs[scratchId] = child;
                } else {
                    convertToCoBlocks(child, coblocksProject);
                    delete lsMyStuffMap[scratchId];
                }
            }
        }
        toDelete.forEach(elem => { elem.remove(); });
        const leftOver = Object.values(lsMyStuffMap);
        leftOver.sort((a, b) => b.lastTime - a.lastTime);
        for (const projObj of leftOver) {
            addProject(projObj, projObj.scratchId in lsProjectDivs);
        }
    });
}


chrome.runtime.sendMessage(exId, { meta: 'getUsernamePlus' }, async (userData) => {
    if (!userData.currentCoBlocksToken) {

        let newVerified = false;
        addStartVerificationCallback(() => {
            document.querySelector('#verifying')?.remove();
            document.querySelector('#unverified')?.remove();
            document.querySelector('.box-head').insertAdjacentHTML('afterend', '<div class="lsBanner" id="verifying" style="background:#e7a91b; color:white;">CoBlocks sign in is in progress…</div>');
        });
        addEndVerificationCallback(async (success, message) => {
            document.querySelector('#verifying')?.remove();
            document.querySelector('#unverified')?.remove();
            if (success) {
                newVerified = true;
                removeHideCoBlocksButton();
                document.querySelector('.box-head').insertAdjacentHTML('afterend', '<div class="lsBanner" id="lsSuccess" style="background:#77da77; color:white;"> ✅ You\'re verified! <div>');
                if (projectLoadFailed) { onTabLoad(); }
                removeHideCoBlocksButton();
                setTimeout(() => { document.querySelector('#lsSuccess')?.remove(); }, 1000 * 2);
            } else {
                document.querySelector('.box-head').insertAdjacentHTML('afterend', '<div class="lsBanner" id="unverified" style="background:#b63b3b; color:white;">CoBlocks sign in failed. Open the extension popup and try Scratch Auth again.</div>');

            }
        });




        chrome.runtime.sendMessage(exId, { meta: 'verifying' }, (verifying) => {
            if (verifying) {
                document.querySelector('#verifying')?.remove();
                document.querySelector('.box-head').insertAdjacentHTML('afterend', '<div class="lsBanner" id="verifying" style="background:#e7a91b; color:white;">CoBlocks sign in is in progress…</div>');
            } else {
                if (newVerified) { return; }
                document.querySelector('.box-head').insertAdjacentHTML('afterend', '<div class="lsBanner" id="unverified" style="background:#b63b3b; color:white;">Connect CoBlocks with Scratch Auth from the extension popup.</div>');
            }
        });


    }
});


function addStartVerificationCallback(cb) {
    chrome.runtime.sendMessage(exId, { meta: 'startVerifyCallback' }, cb);
}
function addEndVerificationCallback(cb) {
    chrome.runtime.sendMessage(exId, { meta: 'endVerifyCallback' }, cb);
}

onTabLoad();


let LSVon = false;
function addHideCoBlocksButton(on) {
    LSVon = on;
    const innerds = on ? 'Hide Verify ^' : 'Show Verify';
    document.getElementById('hideBLButton')?.remove();
    document.querySelector('#main-content > div.action-bar.scroll > div > div').insertAdjacentHTML('afterend', `
    <span class="hideButton" id="hideBLButton" style="text-decoration:underline; cursor:pointer;
  color:lightblue" onclick="(()=>{chrome.runtime.sendMessage(exId,{meta:'dontShowVerifyError',val:${!on}}); toggleHideCoBlocks()})();">${innerds}</span>`);

    document.getElementById('lsBannerCSS')?.remove();
    document.head.insertAdjacentHTML('afterbegin', on ? '<style id="lsBannerCSS">.lsBanner{display:default}</style>' : '<style id="lsBannerCSS">.lsBanner{display:none}</style>');

}
function toggleHideCoBlocks() {
    addHideCoBlocksButton(!LSVon);
}
let actuallyShown = false;
function defaultAddHideCoBlocksButton(hideButton) {
    if (!hideButton) { actuallyShown = true; }
    chrome.runtime.sendMessage(exId, { meta: 'getShowVerifyError' }, answer => {
        addHideCoBlocksButton(answer);
        if (hideButton && !actuallyShown) { removeHideCoBlocksButton(); }
    });

}
function removeHideCoBlocksButton() {
    document.getElementById('hideBLButton')?.remove();
}

defaultAddHideCoBlocksButton(true); // just to add styles
