import {fileURLToPath} from 'node:url';
import {launchNode24} from '../workspace/node24-cli.mjs';

/** Keep both fixed QA entrypoints on the installed project Node24 runtime. */
const [entry,...args]=process.argv.slice(2);
if(!['postgres','native'].includes(entry)){
    console.error('Choose postgres or native, followed by --help or explicit QA arguments.');
    process.exitCode=1;
}else try{
    await launchNode24(fileURLToPath(new URL('./'+entry+'.mjs',import.meta.url)),args);
}catch(error){console.error(error.message);process.exitCode=1;}
