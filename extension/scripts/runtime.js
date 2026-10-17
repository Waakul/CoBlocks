(() => {
    if (window.coBlocksRuntime) return;
    const nativeRuntime = window.chrome?.runtime?.sendMessage ? window.chrome.runtime : null;
    const channel = document.currentScript.dataset.channel;
    const callbacks = new Map();
    const ports = new Map();
    let nextId = 0;
    let bridgeError = null;
    const post = message => window.postMessage(JSON.stringify({ channel, direction: 'page', ...message }), location.origin);
    const eventListeners = () => {
        const listeners = new Set();
        return {
            addListener: listener => listeners.add(listener),
            removeListener: listener => listeners.delete(listener),
            emit: value => listeners.forEach(listener => listener(value)),
        };
    };

    const runtime = {
        get lastError() { return nativeRuntime?.lastError || bridgeError; },
        sendMessage(_extensionId, request, callback) {
            if (nativeRuntime) return nativeRuntime.sendMessage(_extensionId, request, callback);
            const id = ++nextId;
            if (callback) callbacks.set(id, callback);
            post({ type: 'request', id, request });
        },
        connect(extensionId) {
            if (nativeRuntime) return nativeRuntime.connect(extensionId);
            const id = ++nextId;
            const port = {
                onMessage: eventListeners(),
                onDisconnect: eventListeners(),
                postMessage: data => post({ type: 'port-message', id, data }),
                disconnect() {
                    post({ type: 'port-disconnect', id });
                    ports.delete(id);
                    port.onDisconnect.emit(port);
                },
            };
            ports.set(id, port);
            post({ type: 'connect', id });
            return port;
        },
        copyText(text) {
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                callbacks.set(id, () => {
                    if (bridgeError) reject(new Error(bridgeError.message));
                    else resolve();
                });
                post({ type: 'clipboard', id, text });
            });
        },
    };
    window.addEventListener('message', event => {
        if (event.source !== window || event.origin !== location.origin) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.channel !== channel || message.direction !== 'extension') return;
        bridgeError = message.error ? { message: message.error } : null;
        try {
            if (message.type === 'response') {
                const callback = callbacks.get(message.id);
                callbacks.delete(message.id);
                callback?.(message.response);
            } else if (message.type === 'port-message') {
                ports.get(message.id)?.onMessage.emit(message.data);
            } else if (message.type === 'port-disconnect') {
                const port = ports.get(message.id);
                ports.delete(message.id);
                port?.onDisconnect.emit(port);
            }
        } finally {
            bridgeError = null;
        }
    });
    window.coBlocksRuntime = runtime;
})();
