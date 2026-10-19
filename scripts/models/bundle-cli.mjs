import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {packModelBundle,hydrateModelBundle,readModelBundle} from './bundle.mjs';
import {modelBundleFailure} from './bundle-errors.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const usage='Использование: node scripts/models/bundle-cli.mjs --directory <каталог моделей> [--download-only | --verify-only] [--manifest <опись>]\nУпаковка: --pack --directory <исходные модели> --output <новый каталог> --base-url <закреплённый GitHub release>';

function formatBytes(bytes) {
    const units=['Б','КиБ','МиБ','ГиБ'];let index=0,value=bytes;
    while(value>=1024&&index<units.length-1) {value/=1024;index++;}
    return `${index?value.toFixed(1):value} ${units[index]}`;
}

/** Диагностика содержит только стадию и счётчики, без локальных путей или адресов загрузки. */
export function formatModelBundleProgress(value) {
    if(!Number.isSafeInteger(value.completed)||!Number.isSafeInteger(value.total)||value.total<1)return value.message;
    if(value.unit==='files')return `${value.message} ${value.completed}/${value.total} файлов`;
    const percent=Math.min(100,Math.floor(value.completed/value.total*100));
    return `${value.message} ${percent}% · ${formatBytes(value.completed)} / ${formatBytes(value.total)}`;
}

/** Смена стадии видна сразу; потоковые счётчики обновляются не чаще одного раза в две секунды. */
export function modelBundleProgressReporter(write=value=>console.error(value),now=Date.now) {
    let last=0,stage,message;
    return value=>{
        const current=now();
        if(value.stage!==stage||value.message!==message||current-last>=2000||value.stage==='ready') {
            write(formatModelBundleProgress(value));last=current;stage=value.stage;message=value.message;
        }
    };
}

/** CLI не принимает произвольные файлы весов и не исполняет команды из поставки. */
export async function runModelBundleCli(args=process.argv.slice(2)) {
    if(args.length===1&&['--help','-h'].includes(args[0])) {console.log(usage);return;}
    const options={directory:path.join(root,'data/embedding'),manifest:fileURLToPath(new URL('./bundle-release.json',import.meta.url))};
    const values={'--directory':'directory','--manifest':'manifest','--output':'output','--base-url':'baseUrl'};
    const flags={'--download-only':'downloadOnly','--verify-only':'verifyOnly','--pack':'pack'};const seen=new Set();
    for(let index=0;index<args.length;index++) {
        const key=args[index];if(seen.has(key))throw new Error('Параметр указан повторно.\n'+usage);seen.add(key);
        if(flags[key])options[flags[key]]=true;
        else if(values[key]&&args[index+1]&&!args[index+1].startsWith('--'))options[values[key]]=args[++index];
        else throw new Error(usage);
    }
    if(options.pack) {
        if(!options.output||!options.baseUrl||options.downloadOnly||options.verifyOnly||seen.has('--manifest'))throw new Error(usage);
        const manifest=await packModelBundle({...options,directory:path.resolve(options.directory),output:path.resolve(options.output)});
        console.log(JSON.stringify({ok:true,packed:true,files:manifest.files.length,parts:manifest.files.flatMap(file=>file.parts||[]).length}));return;
    }
    if(options.output||options.baseUrl||options.downloadOnly&&options.verifyOnly)throw new Error(usage);
    const manifest=await readModelBundle(path.resolve(options.manifest));
    const report=await hydrateModelBundle({...options,directory:path.resolve(options.directory),manifest,onProgress:modelBundleProgressReporter()});
    console.log(JSON.stringify(report));
}

/** Node разрешает entrypoint через symlink; импорт модуля при этом не должен запускать CLI. */
function isEntrypoint() {
    try {return !!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}
    catch {return false;}
}

if(isEntrypoint()) {
    runModelBundleCli().catch(error=>{
        const failure=modelBundleFailure(error);
        console.error(failure.message);console.log(JSON.stringify({ok:false,error:failure}));process.exitCode=1;
    });
}
