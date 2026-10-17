import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildExtension() {
    const source = path.join(root, 'extension');
    const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
    const destination = path.join(root, 'dist', 'coblocks');
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true });
    await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Built shared Chrome / Firefox extension: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await buildExtension();
}
