import {execFile,spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {ragUiReady} from './contract.js';
const exec=promisify(execFile);
interface BrowserCommand {file:string;args:string[];exists:string}
const safari='on run argv\n tell application "Safari"\n activate\n make new document with properties {URL:(item 1 of argv)}\n end tell\nend run';

/** Только известные браузеры с явным новым окном; системный URL opener не гарантирует отдельное окно. */
export function browserWindowCommands(url:string,platform:string,env:NodeJS.ProcessEnv=process.env):BrowserCommand[]{
    const port=Number(new URL(url).port);ragUiReady({type:'neurocenter-rag-ui-ready',url,port});
    if(platform==='darwin')return ['Google Chrome','Microsoft Edge','Firefox'].map(name=>({file:'/usr/bin/open',exists:`/Applications/${name}.app`,
        args:['-na',`/Applications/${name}.app`,'--args',name==='Firefox'?'-new-window':'--new-window',url]}))
        .concat([{file:'/usr/bin/osascript',exists:'/System/Applications/Safari.app',args:['-e',safari,url]}]);
    if(platform==='win32'){
        const bases=[env.ProgramFiles,env['ProgramFiles(x86)']].filter((base):base is string=>!!base&&/^[A-Za-z]:[\\/]/.test(base));
        return bases.flatMap(base=>[['Google','Chrome','Application','chrome.exe'],['Microsoft','Edge','Application','msedge.exe'],['Mozilla Firefox','firefox.exe']]
            .map(parts=>{const file=path.win32.join(base,...parts);return {file,exists:file,args:[parts.at(-1)==='firefox.exe'?'-new-window':'--new-window',url]};}));
    }
    if(platform==='linux')return ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/microsoft-edge','/usr/bin/firefox','/snap/bin/firefox']
        .map(file=>({file,exists:file,args:[file.endsWith('firefox')?'-new-window':'--new-window',url]}));
    return [];
}
export async function openRagBrowserWindow(url:string):Promise<void>{
    for(const command of browserWindowCommands(url,process.platform)){
        try{await fs.access(command.exists);}catch{continue;}
        try{
            if(process.platform==='darwin')await exec(command.file,command.args,{timeout:8000,maxBuffer:16*1024,windowsHide:true});
            else await dispatchBrowserWindow(command);
            return;
        }catch{/* Следующий установленный браузер; вывод с адресом не публикуется. */}
    }
    throw new Error('Отдельное окно недоступно. Установите Chrome, Edge или Firefox; на macOS также поддерживается Safari.');
}
/** Первый browser instance остаётся приложением пользователя; после startup его не ждём и не завершаем. */
export async function dispatchBrowserWindow(command:Pick<BrowserCommand,'file'|'args'>):Promise<void>{
    const child=spawn(command.file,command.args,{shell:false,detached:true,stdio:'ignore',windowsHide:false});
    await new Promise<void>((resolve,reject)=>{
        let timer:NodeJS.Timeout|undefined;
        const cleanup=()=>{if(timer)clearTimeout(timer);child.off('spawn',spawned);child.off('exit',exited);child.off('error',failed);};
        const accepted=()=>{cleanup();child.on('error',()=>{});child.unref();resolve();};
        const failed=()=>{cleanup();reject(new Error('Браузер не принял запрос на отдельное окно.'));};
        const exited=(code:number|null)=>{if(code===0)accepted();else failed();};
        const spawned=()=>{timer=setTimeout(accepted,350);};
        child.once('spawn',spawned);child.once('exit',exited);child.once('error',failed);
    });
}
