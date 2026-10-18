import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../extension/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/firefox/', import.meta.url));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
const manifestPath = `${destination}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
delete manifest.background.service_worker;
delete manifest.minimum_chrome_version;
delete manifest.externally_connectable;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built Firefox extension: ${destination}`);
