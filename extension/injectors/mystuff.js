const myStuffScript = document.createElement('script');
myStuffScript.className = 'livescratch-ext';
myStuffScript.dataset.exId = chrome.runtime.id;
myStuffScript.src = chrome.runtime.getURL('/scripts/mystuff.js');
injectCoBlocksPageScript(myStuffScript);
