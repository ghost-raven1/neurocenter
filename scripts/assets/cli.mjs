#!/usr/bin/env node
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {syncAssets} from './sync.mjs';
import {modelBundleProgressReporter} from '../models/bundle-cli.mjs';
import {nodeRuntime} from '../workspace/node-runtime.mjs';
import {assetEnvironment} from './environment.mjs';

const usage='Использование: node scripts/assets/cli.mjs [--download-only | --verify-only] [--root <проект>] [--models-directory <кэш моделей>] [--artifacts-directory <кэш инструментов>]';

/** CLI одинаков для Git hook и ручного восстановления; проверка не обращается к сети и не пишет файлы. */
export function parseAssetsArguments(args) {
    if(args.some(value=>['--help','-h','—help'].includes(value)))return {help:true};
    const options={},seen=new Set(),values={'--root':'root','--models-directory':'modelsDirectory','--artifacts-directory':'artifactsDirectory'};
    for(let index=0;index<args.length;index++) {
        const key=args[index];
        if(seen.has(key))throw new Error('Параметр повторён.\n'+usage);seen.add(key);
        if(key==='--verify-only')options.verifyOnly=true;
        else if(key==='--download-only')options.verifyOnly=false;
        else if(Object.hasOwn(values,key)&&args[index+1]&&!args[index+1].startsWith('-'))options[values[key]]=args[++index];
        else throw new Error(usage);
    }
    if(seen.has('--verify-only')&&seen.has('--download-only'))throw new Error('Выберите один режим поставки.\n'+usage);
    return options;
}

export async function runAssetsCli(args=process.argv.slice(2)) {
    const options=parseAssetsArguments(args);
    if(options.help) {console.log(usage);return;}
    const runtime=nodeRuntime();
    if(runtime.node!==process.execPath) {
        const result=spawnSync(runtime.node,[fileURLToPath(import.meta.url),...args],{env:runtime.env,stdio:'inherit'});
        if(result.error)throw result.error;process.exitCode=result.status??1;return;
    }
    const root=path.resolve(options.root||fileURLToPath(new URL('../../',import.meta.url)));
    const environment=await assetEnvironment(root,runtime.env);
    const cancellation=new AbortController();
    const interrupt=()=>cancellation.abort(Object.assign(new Error('Подготовка поставки прервана. Проверенный кэш сохранён; повторите команду.'),{code:'ECANCELED'}));
    process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
    try {
        const report=await syncAssets({...options,root,environment,signal:cancellation.signal,onProgress:modelBundleProgressReporter()});
        console.log(JSON.stringify(report));return report;
    } finally {process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}

function isEntrypoint() {
    try {return !!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));} catch {return false;}
}
if(isEntrypoint()) {
    process.umask(0o077);
    runAssetsCli().catch(error=>{console.error(error.message);console.log(JSON.stringify({ok:false,error:{code:error.code||'ASSETS_SYNC_FAILED',message:error.message}}));process.exitCode=1;});
}
