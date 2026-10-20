import path from 'node:path';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {hydrateModelBundle,recoverManagedModelBundle,rollbackManagedModelBundle} from './bundle.mjs';
import {readModelAsset,modelAssetRuntime,cachedModelTransport} from './source-asset.mjs';
import {assetProgressReporter} from '../assets/progress.mjs';
import {modelBundleFailure} from './bundle-errors.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const usage='npm run models:prepare -- --asset <asset.json> --directory <каталог моделей> [--blob-directory <SHA-кэш>] [--verify-only]\n'
    +'Проверка использует только локальные файлы. Подготовка читает только SHA-кэш импортированного ассета и не обращается к реестру Ollama.\n'
    +'Восстановление журнала: --directory <каталог> --recover-only | --rollback';
const fail=()=>Object.assign(new Error(usage),{code:'MODEL_BUNDLE_USAGE'});

export function parseModelBundleArguments(args) {
    const options={},seen=new Set(),fields={'--asset':'asset','--directory':'directory','--blob-directory':'blobs'},flags={'--verify-only':'verifyOnly','--recover-only':'recoverOnly','--rollback':'rollback'};
    for(let index=0;index<args.length;index++) {
        const key=args[index];if(seen.has(key))throw fail();seen.add(key);
        if(Object.hasOwn(fields,key)&&args[index+1]&&!args[index+1].startsWith('-'))options[fields[key]]=args[++index];
        else if(Object.hasOwn(flags,key))options[flags[key]]=true;
        else throw fail();
    }
    if(!options.directory||[options.verifyOnly,options.recoverOnly,options.rollback].filter(Boolean).length>1)throw fail();
    if(options.recoverOnly||options.rollback){if(options.asset||options.blobs)throw fail();}
    else if(!options.asset||options.verifyOnly&&options.blobs)throw fail();
    return options;
}

/** Нет default-модели, Git adoption, standalone bundle JSON или скрытой загрузки весов. */
export async function runModelBundleCli(args=process.argv.slice(2)) {
    if(args.some(arg=>['--help','-h','—help'].includes(arg))){console.log(usage);return;}
    const options=parseModelBundleArguments(args),directory=path.resolve(options.directory);
    if(options.recoverOnly){console.log(JSON.stringify(await recoverManagedModelBundle(directory)));return;}
    if(options.rollback){console.log(JSON.stringify(await rollbackManagedModelBundle(directory)));return;}
    const asset=await readModelAsset(options.asset),{lock,bundle}=modelAssetRuntime(asset);
    const report=await hydrateModelBundle({directory,manifest:bundle,locks:[lock],verifyOnly:options.verifyOnly===true,
        retainExistingTags:true,onProgress:assetProgressReporter(),fetch:cachedModelTransport(asset,options.blobs||path.join(root,'data/runtime-artifacts/.asset-source-blobs'))});
    console.log(JSON.stringify({...report,assetId:asset.id,version:asset.version,manifestSha256:lock.manifestSha256}));
}

function isEntrypoint(){try{return !!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}}
if(isEntrypoint())runModelBundleCli().catch(error=>{const failure=modelBundleFailure(error);console.error(failure.message);console.log(JSON.stringify({ok:false,error:failure}));process.exitCode=1;});
