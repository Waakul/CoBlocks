(() => {
    const bootstrap = document.querySelector('.livescratch-ext-2');
    if (!bootstrap) return;

    const extensionId = bootstrap.dataset.exId;
    const logoUrl = bootstrap.dataset.logoUrl;
    const seen = new WeakSet();
    const usernameSelectors = [
        '.header-text > h2',
        'a.username[href*="/users/"]',
        '.title > a[href*="/users/"]',
        '.thumbnail-creator > a[href*="/users/"]',
        '#favorites .owner > a[href*="/users/"]',
        '.name > a[href*="/users/"]',
        '.activity-ul a[href*="/users/"]',
        '.studio-project-username',
    ].join(',');

    function sendMessage(message) {
        return new Promise(resolve => chrome.runtime.sendMessage(extensionId, message, resolve));
    }

    function addBadge(usernameElement) {
        const fontSize = Number.parseFloat(getComputedStyle(usernameElement).fontSize) || 14;
        const size = Math.max(16, Math.round(fontSize * 1.2));

        const badge = document.createElement('img');
        badge.className = 'blbadge';
        badge.src = logoUrl;
        badge.alt = '';
        badge.title = 'This user uses CoBlocks';
        badge.width = size;
        badge.height = size;

        const container = document.createElement('span');
        container.className = 'coblocks-user-badge';
        usernameElement.replaceWith(container);
        container.append(usernameElement, badge);
    }

    async function processUsername(usernameElement) {
        if (seen.has(usernameElement)) return;
        seen.add(usernameElement);

        const username = usernameElement.textContent.trim();
        if (!username) return;

        const account = await sendMessage({ meta: 'getUsernamePlus' });
        if (!account) return;

        if (username === account.uname) {
            const isPrivate = await fetch(`${account.apiUrl}/privateMe/${username}`, {
                headers: { authorization: account.currentCoBlocksToken },
            }).then(response => response.json()).catch(() => false);
            if (isPrivate) return;
        }

        const settings = await sendMessage({ meta: 'badges?' });
        if (settings?.badges) return;

        const exists = await sendMessage({ meta: 'userExists', username });
        if (exists) addBadge(usernameElement);
    }

    function scan(root) {
        if (!(root instanceof Element) && root !== document) return;
        const matches = root === document
            ? document.querySelectorAll(usernameSelectors)
            : [
                ...(root.matches(usernameSelectors) ? [root] : []),
                ...root.querySelectorAll(usernameSelectors),
            ];
        for (const element of matches) processUsername(element).catch(console.error);
    }

    scan(document);
    new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) scan(node);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
