import {fileURLToPath} from 'node:url';
import {launchNode24} from './node24-cli.mjs';

/** Keep source planning on the same installed Node24 runtime as workspace checks. */
try{await launchNode24(fileURLToPath(new URL('./impact-plan.mjs',import.meta.url)),process.argv.slice(2));}
catch(error){console.error(error.message);process.exitCode=1;}
