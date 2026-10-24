import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const {RUNTIME_USE_ENTRYPOINTS}=createRequire(import.meta.url)('../../../services/shared/bridge-update-cleanup.cjs');
const exportsByEntry={
    'dist/bridge/connect.js':['startWorker','connectBridge','watchPair'],
    'dist/features/opencode-providers/authorization.js':['authorizeManagedProvider'],
    'dist/features/opencode-providers/ollama-sdk.js':['createOllama'],
};

/** Register usage before loading modules that may keep reading this installed runtime. */
export async function writeRuntimeBootstraps(dist){
    for(const entry of RUNTIME_USE_ENTRYPOINTS){
        const relative=entry.slice('dist/'.length),file=path.join(dist,relative);
        const main=relative.replace(/\.js$/,'-main.js');
        await fs.rename(file,path.join(dist,main));
        const helper=path.posix.relative(path.posix.dirname(relative),'shared/bridge-update-cleanup.cjs');
        const imports=`import cleanup from ${JSON.stringify(helper.startsWith('.')?helper:'./'+helper)};\nawait cleanup.acquireForEntrypoint(import.meta.url);\n`;
        const names=exportsByEntry[entry]??[];
        const body=names.length?`const runtime=await import(${JSON.stringify('./'+path.posix.basename(main))});\n${names.map(name=>`export const ${name}=runtime.${name};`).join('\n')}\n`
            :`await import(${JSON.stringify('./'+path.posix.basename(main))});\n`;
        await fs.writeFile(file,imports+body,{flag:'wx'});
    }
    await fs.writeFile(path.join(dist,'runtime-use.json'),JSON.stringify({schemaVersion:1,entrypoints:RUNTIME_USE_ENTRYPOINTS})+'\n',{flag:'wx'});
}
