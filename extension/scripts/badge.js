(() => {
    const bootstrap = document.querySelector('.livescratch-ext-2');
    if (!bootstrap) return;

    const extensionId = bootstrap.dataset.exId;
    const logoUrl = bootstrap.dataset.logoUrl;
    const seen = new WeakSet();
    const pendingUsers = [];
    let activeRequests = 0;
    const settings = new Promise(resolve => window.coBlocksRuntime.sendMessage(extensionId, { meta: 'badges?' }, resolve));
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
        return new Promise(resolve => window.coBlocksRuntime.sendMessage(extensionId, message, resolve));
    }

    function addBadge(usernameElement) {
        const fontSize = Number.parseFloat(getComputedStyle(usernameElement).fontSize) || 14;
        const size = Math.min(24, Math.max(14, Math.round(fontSize * 1.2)));

        const badge = document.createElement('img');
        badge.className = 'blbadge';
        badge.src = logoUrl;
        badge.alt = '';
        badge.title = 'This user uses CoBlocks';
        badge.width = size;
        badge.height = size;
        badge.style.setProperty('--coblocks-badge-size', `${size}px`);

        // Keep Scratch's original username/link structure and grid selectors.
        usernameElement.append(badge);
    }

    async function processUsername(usernameElement) {
        if ((await settings)?.badges) return;
        const path = usernameElement.getAttribute('href');
        const username = path?.match(/^\/users\/([a-zA-Z0-9_-]{3,20})\/?$/)?.[1]
            || usernameElement.textContent.trim();
        if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return;
        if (!usernameElement.isConnected) return;

        const exists = await sendMessage({ meta: 'userExists', username });
        if (exists === true && usernameElement.isConnected) addBadge(usernameElement);
    }

    function queueUsername(element) {
        if (seen.has(element)) return;
        seen.add(element);
        pendingUsers.push(element);
        drainQueue();
    }

    function drainQueue() {
        while (activeRequests < 4 && pendingUsers.length) {
            activeRequests++;
            processUsername(pendingUsers.shift()).catch(console.error).finally(() => {
                activeRequests--;
                drainQueue();
            });
        }
    }

    function scan(root) {
        if (!(root instanceof Element) && root !== document) return;
        const matches = root === document
            ? document.querySelectorAll(usernameSelectors)
            : [
                ...(root.matches(usernameSelectors) ? [root] : []),
                ...root.querySelectorAll(usernameSelectors),
            ];
        for (const element of matches) queueUsername(element);
    }

    scan(document);
    new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) scan(node);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
