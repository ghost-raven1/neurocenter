import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packModelBundle,hydrateModelBundle,readModelBundle} from './bundle.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const usage='Использование: node scripts/models/bundle-cli.mjs --directory <каталог моделей> [--download-only | --verify-only] [--manifest <опись>]\nУпаковка: --pack --directory <исходные модели> --output <новый каталог> --base-url <закреплённый GitHub release>';

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
    const manifest=await readModelBundle(path.resolve(options.manifest));let last=0;
    const report=await hydrateModelBundle({...options,directory:path.resolve(options.directory),manifest,onProgress:value=>{
        if(Date.now()-last>2000||value.stage==='ready') {console.error(value.message);last=Date.now();}
    }});
    console.log(JSON.stringify(report));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    runModelBundleCli().catch(error=>{console.error(error?.code?'Не удалось подготовить поставку моделей. Проверьте хранилище, сеть и повторите запуск.':error instanceof Error?error.message:'Не удалось подготовить модели.');process.exitCode=1;});
}
