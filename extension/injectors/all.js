const badgeScript = document.createElement('script');
badgeScript.className = 'livescratch-ext-2';
badgeScript.dataset.exId = chrome.runtime.id;
badgeScript.dataset.logoUrl = chrome.runtime.getURL('/img/CoBlocksIcon.png');
badgeScript.src = chrome.runtime.getURL('/scripts/badge.js');
(document.head || document.documentElement).appendChild(badgeScript);
