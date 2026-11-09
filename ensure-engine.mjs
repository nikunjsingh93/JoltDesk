import {existsSync} from 'node:fs';
import path from 'node:path';
if(!existsSync(path.resolve('engine-bundle','bundle-meta.json')))await import('./bundle-engine.mjs');
