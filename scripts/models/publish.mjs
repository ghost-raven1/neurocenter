import {constants,createReadStream} from 'node:fs';
import {readFile,writeFile,lstat,open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {validateAsset,serializeAsset} from '@neurocenter/asset-contract';
import {packModelBundle} from './bundle.mjs';
import {sha256,lockedFiles,releaseBaseUrl,modelName,validateModelBundle} from './bundle-manifest.mjs';
import {safeDirectory,ensureSpace,verifyFile} from './bundle-files.mjs';
import {readModelAsset} from './source-asset.mjs';
import {withAssetsLock} from '../assets/lock.mjs';

const execute=promisify(execFile),repository='ghost-raven1/neurocenter-assets';

/** Из прочитанных локальных байтов формируется lock; старый реестр или рецепт не нужен. */
async function localModel({root,directory,model,id,name,capability,dimension,description,license}) {
    if(typeof model!=='string'||!modelName.test(model))throw new Error('Укажите установленную модель namespace/name:tag через --model.');
    if(capability!==undefined&&!['embedding','vision','chat'].includes(capability))throw new Error('Capability: embedding, vision или chat.');
    if(dimension!==undefined&&(!Number.isSafeInteger(dimension)||dimension<1||dimension>16384))throw new Error('Dimension: целое число 1–16384.');
    const [modelPath,tag]=model.split(':'),relative=`models/manifests/registry.ollama.ai/${modelPath.includes('/')?modelPath:'library/'+modelPath}`;
    await safeDirectory(directory,relative);
    const filename=path.join(directory,relative,tag),handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let bytes;
    try {const info=await handle.stat();if(!info.isFile()||info.nlink!==1||info.size<1||info.size>128*1024)throw new Error('Нужен обычный локальный manifest до 128 КиБ.');bytes=await handle.readFile();const after=await handle.stat();if(bytes.length!==info.size||after.mtimeMs!==info.mtimeMs)throw new Error('Manifest изменился во время чтения.');}
    finally {await handle.close();}
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    capability??=/(?:embedding|embed)(?:[:._-]|$)/i.test(model)?'embedding':undefined;
    if(!capability)throw new Error('Тип модели не определён однозначно. Укажите --capability embedding, vision или chat.');
    if(dimension!==undefined&&capability!=='embedding')throw new Error('Размерность задаётся только embedding-модели.');
    const image=(await readFile(path.join(root,'compose.embedding.yml'),'utf8')).match(/^\s*image:\s*(ollama\/ollama:[^\s]+@sha256:[a-f0-9]{64})\s*$/m)?.[1];
    if(!image)throw new Error('Не найден закреплённый runtime image в compose.embedding.yml.');
    const lock={schemaVersion:1,model,manifestSha256:sha256(bytes),manifest,image,registryManifestUrl:`https://registry.ollama.ai/v2/${modelPath.includes('/')?modelPath:'library/'+modelPath}/manifests/${tag}`,capability,...(dimension!==undefined?{dimension}:{})};
    lockedFiles([lock]);
    id??='model-'+model.replace(/[^a-z0-9]+/gi,'-').toLowerCase().replace(/-+$/,'');name??=model;
    if(!/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(id)||typeof name!=='string'||!name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw new Error('Проверьте --id model-name и --name до 128 символов.');
    const card={id,name,descriptor:{description:description||`Локальная ${capability}-модель ${model}.`,capability,runtime:'ollama',model,manifestSha256:lock.manifestSha256,dimension:dimension??null,source:'builtin'}};
    return {lock,card,license:{spdx:license||'NOASSERTION'}};
}

/** Повтор проверяет каждый локальный part и итоговую SHA перед использованием готового выпуска. */
async function preparedAsset(output,expected) {
    try{await lstat(output);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    await safeDirectory(output);const asset=await readModelAsset(path.join(output,'asset.json'));
    for(const key of ['id','version','source','card','license'])if(!isDeepStrictEqual(asset[key],expected[key]))throw new Error('Готовый output относится к другому ассету. Укажите новый --output.');
    if(!isDeepStrictEqual(asset.delivery.lock,expected.lock))throw new Error('Manifest локальной модели изменился. Укажите новую версию и output.');
    validateModelBundle(asset.delivery.bundle,[expected.lock]);
    for(const file of asset.delivery.bundle.files.filter(file=>file.parts)){
        const complete=(await import('node:crypto')).createHash('sha256');
        for(const part of file.parts){const filename=path.join(output,part.name);if(!await verifyFile(filename,part))throw new Error('Часть готовой поставки повреждена.');for await(const bytes of createReadStream(filename,{flags:constants.O_RDONLY|constants.O_NOFOLLOW}))complete.update(bytes);}
        if(complete.digest('hex')!==file.sha256)throw new Error('Итоговая SHA модели не совпала.');
    }
    return asset;
}

async function ghRun(args) {
    const result=await execute('gh',args,{maxBuffer:4*1024*1024});return result.stdout;
}

/** Новый draft публикуется только после проверки перечня, размеров и серверных SHA загруженных assets. */
export async function publishModelAssets({release,output,manifest,run=ghRun,onProgress=()=>{}}) {
    const assets=manifest.files.flatMap(file=>file.parts||[]).map(part=>({name:part.name,size:part.size,sha256:part.sha256}));
    const metadata=await readFile(path.join(output,'asset.json'));
    assets.push({name:'asset.json',size:metadata.length,sha256:sha256(metadata)});
    const read=async()=>JSON.parse(await run(['api',`repos/${repository}/releases/tags/${release}`]));
    let remote;
    try {remote=await read();} catch(error) {if(!/\bHTTP 404\b/.test(error.stderr||''))throw error;}
    const matching=(item,asset)=>item.name===asset.name&&item.size===asset.size&&item.digest==='sha256:'+asset.sha256;
    const valid=(value,complete)=>value?.tag_name===release&&typeof value.draft==='boolean'&&Array.isArray(value.assets)
        &&new Set(value.assets.map(item=>item.name)).size===value.assets.length
        &&value.assets.every(item=>assets.some(asset=>matching(item,asset)))
        &&(!complete||value.assets.length===assets.length);
    if(remote&&!valid(remote,!remote.draft))throw new Error('Существующий release отличается от подготовленной поставки. Выберите новый --release. Исходный репозиторий не изменён.');
    if(!remote) {
        await onProgress({stage:'creating-release',message:'Создаём черновик поставки на GitHub.'});
        await run(['release','create',release,'--repo',repository,'--draft','--title',release,'--notes','Закреплённая поставка локальных моделей Нейроцентра. Source envelope asset.json закрепляет все части и SHA-256.']);
        remote={tag_name:release,draft:true,assets:[]};
    }
    if(remote.draft) {
        const missing=assets.filter(asset=>!remote.assets.some(item=>matching(item,asset)));
        for(let index=0;index<missing.length;index+=25) {
            await onProgress({stage:'uploading',message:`Загружаем части на GitHub: ${Math.min(index+25,missing.length)} / ${missing.length}. Уже проверенные части не отправляются повторно.`});
            await run(['release','upload',release,'--repo',repository,...missing.slice(index,index+25).map(asset=>path.join(output,asset.name))]);
        }
        await onProgress({stage:'verifying-release',message:'Проверяем размеры и SHA-256 всех частей на GitHub перед публикацией.'});
        if(!valid(await read(),true))throw new Error('GitHub не подтвердил все части поставки по SHA-256. Draft сохранён; файлы Git не изменены.');
        await run(['release','edit',release,'--repo',repository,'--draft=false']);
        remote=await read();
    }
    if(!valid(remote,true)||remote.draft)throw new Error('GitHub не подтвердил публикацию моделей. Исходный репозиторий не изменён.');
}

/** Один выбранный локальный manifest создаёт один source asset; Git checkout не меняется. */
export async function prepareModelSupply(options,dependencies={}) {
    return withAssetsLock(options.root,async()=>{
        const {root,release,publish=false}=options,progress=dependencies.onProgress||(()=>{});
        if(typeof release!=='string'||!release)throw new Error('Укажите неизменяемый --release.');
        const baseUrl=releaseBaseUrl(`https://github.com/${repository}/releases/download/${release}`);
        if(typeof publish!=='boolean')throw new Error('Некорректный режим публикации.');
        const directory=await safeDirectory(path.resolve(options.directory||path.join(root,'data/embedding')));
        const {lock,card,license}=await localModel({...options,directory});
        const expected={schemaVersion:1,id:card.id,kind:'model',version:options.version||release,source:{type:'release',repository:`https://github.com/${repository}`,tag:release},license,compatibility:{},card,lock};
        const output=path.resolve(options.output||path.join(root,'.run/model-supply',release,card.id));
        await safeDirectory(path.dirname(output),'',true);
        await progress({stage:'inspecting',message:'Проверяем локальный manifest и source envelope.'});
        let asset=await preparedAsset(output,expected);
        if(!asset){
            const files=lockedFiles([lock]);await ensureSpace(path.dirname(output),[...files.values()].reduce((sum,file)=>sum+(file.size||0),0),dependencies.readDisk);
            const bundle=await (dependencies.pack||packModelBundle)({directory,output,baseUrl,locks:[lock]});
            const {lock:_,...metadata}=expected;asset=validateAsset({...metadata,delivery:{type:'model-bundle',lock,bundle}});
            await writeFile(path.join(output,'asset.json'),serializeAsset(asset),{flag:'wx',mode:0o600});
        }
        if(publish)await publishModelAssets({release,output,manifest:asset.delivery.bundle,run:dependencies.run,onProgress:progress});
        return {ok:true,published:publish,id:asset.id,version:asset.version,release,files:asset.delivery.bundle.files.length,parts:asset.delivery.bundle.files.flatMap(file=>file.parts||[]).length,output,descriptor:path.join(output,'asset.json')};
    },{onProgress:dependencies.onProgress});
}
