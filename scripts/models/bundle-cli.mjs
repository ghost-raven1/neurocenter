import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {packModelBundle,hydrateModelBundle,readModelBundle,rollbackManagedModelBundle} from './bundle.mjs';
import {modelBundleFailure} from './bundle-errors.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const usage='Использование: node scripts/models/bundle-cli.mjs --directory <каталог моделей> [--download-only | --verify-only | --rollback | --adopt-from-git <commit|ORIG_HEAD>] [--manifest <опись>] [--source-directory <предзагрузка>]\nУпаковка: --pack --directory <исходные модели> --output <новый каталог> --base-url <закреплённый GitHub release>';
const usageError=(message='Некорректные параметры команды.')=>Object.assign(new Error(message+'\n'+usage),{code:'MODEL_BUNDLE_USAGE'});

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
    // npm run models:verify уже добавляет --verify-only перед пользовательским --help.
    if(args.some(arg=>['--help','-h','—help'].includes(arg))) {console.log(usage);return;}
    const options={directory:path.join(root,'data/embedding'),manifest:fileURLToPath(new URL('./bundle-release.json',import.meta.url))};
    const values={'--directory':'directory','--manifest':'manifest','--output':'output','--base-url':'baseUrl','--adopt-from-git':'adoptFromGit','--source-directory':'sourceDirectory'};
    const flags={'--download-only':'downloadOnly','--verify-only':'verifyOnly','--pack':'pack','--rollback':'rollback'};const seen=new Set();
    for(let index=0;index<args.length;index++) {
        const key=args[index];if(seen.has(key))throw usageError('Параметр указан повторно.');seen.add(key);
        if(Object.hasOwn(flags,key))options[flags[key]]=true;
        else if(Object.hasOwn(values,key)&&args[index+1]&&!args[index+1].startsWith('--'))options[values[key]]=args[++index];
        else throw usageError();
    }
    if(options.pack) {
        if(!options.output||!options.baseUrl||options.downloadOnly||options.verifyOnly||options.rollback||options.adoptFromGit||options.sourceDirectory||seen.has('--manifest'))throw usageError();
        const manifest=await packModelBundle({...options,directory:path.resolve(options.directory),output:path.resolve(options.output)});
        console.log(JSON.stringify({ok:true,packed:true,files:manifest.files.length,parts:manifest.files.flatMap(file=>file.parts||[]).length}));return;
    }
    if(options.output||options.baseUrl||[options.downloadOnly,options.verifyOnly,options.rollback,options.adoptFromGit].filter(Boolean).length>1)throw usageError();
    if(options.sourceDirectory&&(options.verifyOnly||options.rollback||options.adoptFromGit))throw usageError();
    if(options.adoptFromGit) {
        if(seen.has('--manifest'))throw usageError();
        const {adoptModelBundleFromGit}=await import('./bundle-git-adoption.mjs');
        console.log(JSON.stringify(await adoptModelBundleFromGit({root,directory:path.resolve(options.directory),reference:options.adoptFromGit,onProgress:modelBundleProgressReporter()})));return;
    }
    if(options.rollback) {
        if(seen.has('--manifest'))throw usageError();
        console.log(JSON.stringify(await rollbackManagedModelBundle(path.resolve(options.directory))));return;
    }
    const manifest=await readModelBundle(path.resolve(options.manifest));
    const directory=path.resolve(options.directory),onProgress=modelBundleProgressReporter();
    let locks;
    if(options.sourceDirectory) {
        const {modelLocks,validateModelBundle}=await import('./bundle-manifest.mjs');
        const {copyPrefetchedModels}=await import('./prefetch-cache.mjs');
        locks=await modelLocks();validateModelBundle(manifest,locks);
        await copyPrefetchedModels({source:path.resolve(options.sourceDirectory),directory,manifest,locks,onProgress});
    }
    const report=await hydrateModelBundle({...options,directory,manifest,locks,onProgress});
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
        console.error(failure.message);
        if(failure.code==='MODEL_BUNDLE_USAGE')console.error(usage);
        console.log(JSON.stringify({ok:false,error:failure}));process.exitCode=1;
    });
}
