import fs from 'node:fs/promises';
import path from 'node:path';
import {safeTarget} from '../../bridge/workspace.js';
import {InstallationPlan} from '../../bridge/installation-plan.js';
export const MAX_TEXT_BYTES=256*1024;
export const OPEN_CODE_CONFIGS=['opencode.json','opencode.jsonc','.opencode/opencode.json','.opencode/opencode.jsonc'];
export const RAG_CONFIGS=['opencode-rag.json','.opencode/opencode-rag.json','.opencode/rag.json'];
export type ConfigurationFile={path:string;kind:'markdown'|'opencode'|'rag';exists:boolean;readonly:boolean};
const skipped=new Set(['.git','node_modules','.run','.next','dist','build','coverage','vendor','target','.venv','venv','.cache','.idea','.vscode']);
/** Bounded project-only discovery never follows directory links or package/runtime trees. */
export async function discoverFiles(root:string,plan:InstallationPlan,rag:boolean){
    const files=new Map<string,ConfigurationFile>();let entries=0,limited=false;
    const add=async(relative:string,kind:ConfigurationFile['kind'],create=false)=>{
        const raw=await plan.read(relative);if(raw===null&&!create)return;
        if(raw!==null&&Buffer.byteLength(raw)>MAX_TEXT_BYTES)throw Error('Файл настройки превышает 256 КиБ.');
        files.set(relative,{path:relative,kind,exists:raw!==null,readonly:/^\.opencode\/(agents?|modes?)\/(?:[^/]+\/)*nc-[^/]+\.md$/i.test(relative)||relative.startsWith('.opencode/plugins/neurocenter-')});
    };
    for(const relative of OPEN_CODE_CONFIGS)await add(relative,'opencode',relative==='opencode.jsonc');
    await add('AGENTS.md','markdown',true);await add('CLAUDE.md','markdown');
    if(rag){let found=false;for(const relative of RAG_CONFIGS){const raw=await plan.read(relative);if(raw!==null){await add(relative,'rag');found=true;}}if(!found)await add(RAG_CONFIGS[0]!,'rag',true);}
    const walk=async(relative:string,depth:number,markdown=false):Promise<void>=>{
        if(depth>6||entries>=3000||files.size>=120){limited=true;return;}
        const directory=await safeTarget(root,relative||'.opencode').catch(()=>null); // root itself is already a verified binding.
        const target=relative?directory:root;if(!target)return;
        const handle=await fs.opendir(target).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});if(!handle)return;
        try{for await(const entry of handle){if(++entries>3000||files.size>=120){limited=true;break;}if(entry.isSymbolicLink())continue;
            const child=relative?relative+'/'+entry.name:entry.name;
            if(entry.isDirectory()){
                if(skipped.has(entry.name)||entry.name.startsWith('.')&&entry.name!=='.opencode')continue;
                if(child==='.opencode'){for(const folder of ['agents','agent','commands','command','rules','modes','mode'])await walk('.opencode/'+folder,depth+1,true);continue;}
                await walk(child,depth+1,markdown);
            }else if(entry.isFile()&&(entry.name==='AGENTS.md'||markdown&&entry.name.endsWith('.md')))await add(child,'markdown');
        }}finally{await handle.close().catch(()=>{});}
    };
    await walk('',0);return {files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),limited};
}
