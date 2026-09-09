import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const assets = (await readdir('dist/assets')).filter(name => /\.(js|css|woff2|svg|png)$/.test(name)).map(name => `/assets/${name}`);
const html = await readFile('dist/index.html', 'utf8');
const version = createHash('sha256').update(html + assets.join(',')).digest('hex').slice(0, 16);
const sw = await readFile('dist/sw.js', 'utf8');
await writeFile('dist/sw.js', sw.replace('__BUILD_ID__', version).replace('/* __SHELL_ASSETS__ */ []', JSON.stringify(['/index.html', '/favicon.svg', ...assets])));
