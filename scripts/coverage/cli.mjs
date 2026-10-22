import {fileURLToPath} from 'node:url';
import {launchNode24} from '../workspace/node24-cli.mjs';

try { await launchNode24(fileURLToPath(new URL('./run.mjs', import.meta.url))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
