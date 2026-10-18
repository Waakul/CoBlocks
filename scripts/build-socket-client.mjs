import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Browser extension contexts always provide self. Replace the upstream fallback
// during bundling so the client never needs to evaluate a string as JavaScript.
await build({
    stdin: {
        contents: "import { io, Manager, Socket } from 'socket.io-client'; self.io = Object.assign(io, { connect: io, io, Manager, Socket });",
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome121', 'firefox140'],
    outfile: fileURLToPath(new URL('../extension/background/socket.io.js', import.meta.url)),
    banner: { js: '/*! Socket.IO client 4.4.1 — MIT License. Rebuilt with scripts/build-socket-client.mjs. */' },
    plugins: [{
        name: 'extension-global',
        setup(builder) {
            builder.onLoad({ filter: /engine\.io-client\/.*\/globalThis\.browser\.js$/ }, () => ({
                contents: 'export default self;',
                loader: 'js',
            }));
        },
    }],
});
