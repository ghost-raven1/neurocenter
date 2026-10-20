import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {prepareModelSupply} from './publish.mjs';
import {nodeRuntime} from '../workspace/node-runtime.mjs';
import {assetEnvironment} from '../assets/environment.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const usage='npm run models:publish -- --model <namespace/name:tag> --release <immutable-tag> [--id model-name] [--name <название>] [--capability embedding|vision|chat] [--dimension N] [--license SPDX] [--directory data/embedding] [--output <новый каталог>] [--publish]\n'
    +'Без --publish: только локальная упаковка в asset.json. С --publish: проверенный GitHub Release в neurocenter-assets. Git checkout не меняется.';

export function parseModelPublishArguments(args) {
    const options={root,publish:false},seen=new Set();
    const fields={'--model':'model','--id':'id','--name':'name','--capability':'capability','--dimension':'dimension','--description':'description','--license':'license','--version':'version','--release':'release','--directory':'directory','--output':'output'};
    for(let index=0;index<args.length;index++) {
        const key=args[index],field=fields[key]||key;
        if(seen.has(field))throw new Error('Параметр указан повторно.');seen.add(field);
        if(key==='--publish')options.publish=true;
        else if(Object.hasOwn(fields,key)&&args[index+1]&&!args[index+1].startsWith('-'))options[fields[key]]=args[++index];
        else throw new Error(usage);
    }
    if(!options.model||!options.release)throw new Error(usage);
    if(options.dimension!==undefined){if(!/^[1-9][0-9]{0,4}$/.test(options.dimension))throw new Error(usage);options.dimension=Number(options.dimension);}
    return options;
}

/** Никаких сетевых действий при справке или импорте; публикация требует явного --publish. */
export async function runModelPublishCli(args=process.argv.slice(2)) {
    if(args.some(arg=>['--help','-h','—help'].includes(arg))) {console.log(usage);return;}
    const options=parseModelPublishArguments(args),runtime=nodeRuntime();
    if(runtime.node!==process.execPath) {
        const result=spawnSync(runtime.node,[fileURLToPath(import.meta.url),...args],{env:runtime.env,stdio:'inherit'});
        if(result.error)throw result.error;process.exitCode=result.status??1;return;
    }
    const environment=await assetEnvironment(root,runtime.env);
    options.directory=path.resolve(root,options.directory||environment.MODEL_STORAGE_PATH||environment.EMBEDDING_DATA_DIR||'data/embedding');
    const result=await prepareModelSupply(options,{onProgress:value=>console.error(value.message)});
    console.log(JSON.stringify(result,null,2));
    if(!result.published)console.error('Комплект подготовлен локально. Для публикации повторите ту же команду с --publish: части будут проверены и использованы повторно.');
    else console.error('Поставка опубликована в neurocenter-assets. Добавьте полученный asset.json в индекс репозитория; готовые версии не перезаписываются.');
}

function isEntrypoint() {
    try {return !!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}
    catch {return false;}
}
if(isEntrypoint())runModelPublishCli().catch(error=>{console.error(error.message);process.exitCode=1;});
