chrome.runtime.sendMessage({ meta: 'getExtensionUpdateNotice' }, notice => {
    if (chrome.runtime.lastError || !notice || !document.body) return;
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
        <style>
            :host { position: fixed; bottom: 16px; left: 16px; z-index: 10000; width: min(350px, calc(100vw - 32px)); }
            * { box-sizing: border-box; }
            aside { padding: 16px; border: 1px solid #dce1eb; border-radius: 14px; background: #fff; color: #14264d; box-shadow: 0 8px 30px #14264d26; font: 13px/1.5 system-ui, sans-serif; animation: appear .18s ease-out; }
            header { display: flex; gap: 10px; align-items: center; padding-right: 18px; }
            img { width: 32px; height: 32px; }
            h2 { margin: 0; font-size: 16px; }
            small { color: #68748a; }
            h3 { margin: 12px 0 5px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            p { margin: 0 0 4px; color: #526079; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
            a { color: #274e91; font-weight: 650; text-decoration: none; }
            a:hover { text-decoration: underline; }
            nav { display: flex; gap: 8px; margin-top: 14px; }
            nav a { flex: 1; padding: 8px; border: 1px solid #e0e5ef; border-radius: 8px; text-align: center; font-size: 12px; }
            nav a:first-child { background: #ffe491; border-color: #ffda64; color: #14264d; }
            nav a:hover { background: #f0f3f9; text-decoration: none; }
            nav a:first-child:hover { background: #ffdb70; }
            button { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: #68748a; font-size: 20px; cursor: pointer; }
            button:hover { background: #edf0f6; }
            :focus-visible { outline: 2px solid #3278b8; outline-offset: 2px; }
            @keyframes appear { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
            @media (prefers-reduced-motion: reduce) { aside { animation: none; } }
        </style>
        <aside role="status" aria-live="polite">
            <button type="button" aria-label="Dismiss update notice">×</button>
            <header><img alt=""><div><h2>CoBlocks updated</h2><small></small></div></header>
            <h3></h3><p></p><a class="read-more">Read more…</a>
            <nav aria-label="Release links"><a>View release notes</a><a>All releases</a></nav>
        </aside>`;
    shadow.querySelector('img').src = chrome.runtime.getURL('img/CoBlocksIcon.png');
    shadow.querySelector('small').textContent = `Version ${notice.version}`;
    shadow.querySelector('h3').textContent = notice.release.title;
    shadow.querySelector('p').textContent = notice.release.preview;
    const links = shadow.querySelectorAll('a');
    links.forEach((link, index) => {
        link.href = index === 2 ? notice.releasesPage : notice.release.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    });
    shadow.querySelector('button').onclick = () => host.remove();
    document.body.appendChild(host);
    chrome.runtime.sendMessage({ meta: 'extensionUpdateNoticeShown', version: notice.version }, () => {
        if (chrome.runtime.lastError) console.warn('Could not mark the CoBlocks update notice as shown.');
    });
});
