import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(await readFile(new URL('node_modules/socket.io-client/package.json', import.meta.url), 'utf8'));

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
    banner: { js: `/*! Socket.IO client ${version} — MIT License. Rebuilt with scripts/build-socket-client.mjs. */` },
    plugins: [{
        name: 'extension-global',
        setup(builder) {
            builder.onLoad({ filter: /engine\.io-client\/.*\/globals\.js$/ }, async ({ path }) => {
                const source = await readFile(path, 'utf8');
                const fallback = 'return Function("return this")();';
                if (!source.includes(fallback)) throw new Error('Review the Engine.IO global shim before rebuilding.');
                return { contents: source.replace(fallback, 'return self;'), loader: 'js' };
            });
        },
    }],
});
