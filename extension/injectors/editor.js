const editorScript = document.createElement('script');
editorScript.className = 'livescratch-ext';
editorScript.dataset.exId = chrome.runtime.id;
editorScript.src = chrome.runtime.getURL('/scripts/editor.js');
(document.head || document.documentElement).appendChild(editorScript);
