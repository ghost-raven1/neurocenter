const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const lock=require('./bundled-catalog.lock.json');
const root=path.resolve(__dirname,'../..');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const relative=value=>typeof value==='string'&&value.length<=240&&!/[\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>part&&!['.','..'].includes(part));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=()=>Object.assign(new Error('Исходники каталога отсутствуют или повреждены. Обновите приложение из проверенной версии Git.'),{code:'BUNDLED_CATALOG_INVALID'});

/** App-owned files are immutable inputs; links, partial writes and digest mismatches never fall back to the network. */
async function checkedFile(directory,filename,expected,maximum){
    try{
    if(!relative(filename)||!sha(expected)||!Number.isSafeInteger(maximum)||maximum<1)throw failure();
    const parents=[];let current=directory;
    for(const segment of ['',...filename.split('/').slice(0,-1)]){
        if(segment)current=path.join(current,segment);const info=await fs.lstat(current);
        if(!info.isDirectory()||info.isSymbolicLink())throw failure();parents.push([current,info]);
    }
    const full=path.join(directory,filename),handle=await fs.open(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const before=await handle.stat();
        if(!before.isFile()||before.nlink!==1||before.size>maximum)throw failure();
        const bytes=Buffer.alloc(before.size);let offset=0;
        while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw failure();offset+=read.bytesRead;}
        const after=await handle.stat(),named=await fs.lstat(full);
        if(bytes.length!==before.size||bytes.length>maximum||digest(bytes)!==expected||named.isSymbolicLink()
            ||[after,named].some(info=>info.dev!==before.dev||info.ino!==before.ino||info.size!==before.size||info.mtimeMs!==before.mtimeMs||info.ctimeMs!==before.ctimeMs))throw failure();
        for(const [name,info]of parents){const after=await fs.lstat(name);if(after.isSymbolicLink()||after.ino!==info.ino||after.dev!==info.dev)throw failure();}
        return bytes;
    }finally{await handle.close();}
    }catch{throw failure();}
}
const json=bytes=>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure();}};

/** Source revisions describe approved recipes; they do not claim an installed or already built runtime. */
async function readBundledCatalog(directory=root){
    const bytes=await checkedFile(directory,lock.path,lock.sha256,512*1024),manifest=json(bytes);
    if(manifest.schemaVersion!==1||manifest.kind!=='app-bundled-catalog'||!sha(manifest.index?.sha256)||manifest.index.path!=='bundled/index.json'
        ||!Array.isArray(manifest.current)||manifest.current.length>100||!Array.isArray(manifest.files)||manifest.files.length>300
        ||!Array.isArray(manifest.history?.snapshots)||manifest.history.snapshots.length>100||typeof manifest.history.repository!=='string')throw failure();
    const files=new Map();let total=0;
    for(const file of manifest.files){
        if(!relative(file.path)||!sha(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>16*1024*1024||files.has(file.path))throw failure();
        files.set(file.path,file);total+=file.bytes;
    }
    if(total>16*1024*1024||new Set(manifest.current.map(row=>row.id)).size!==manifest.current.length)throw failure();
    const sourceRoot=path.join(directory,'catalog-source');
    const read=async filename=>{const file=files.get(filename);if(!file)throw failure();return checkedFile(sourceRoot,filename,file.sha256,file.bytes+1);};
    const producer=files.get('producer.json');if(!producer)throw failure();
    await verifyBundledProducer(producer.sha256,directory);
    const metadata=async(expected,maximum)=>{
        if(!sha(expected))throw failure();const filename='metadata/'+expected+'.json',file=files.get(filename);
        if(!file)return undefined;if(file.bytes>maximum)throw failure();return read(filename);
    };
    const pin={schemaVersion:2,repository:'app-bundled',commit:'sha256:'+manifest.index.sha256,index:manifest.index};
    const historicalPins=manifest.history.snapshots.map(({commit,indexSha256})=>{
        if(!/^[a-f0-9]{40}$/.test(commit)||!sha(indexSha256)||!files.has('metadata/'+indexSha256+'.json'))throw failure();
        return {schemaVersion:1,repository:manifest.history.repository,commit,index:{path:'index.json',sha256:indexSha256}};
    });
    const plans=manifest.current.filter(row=>row.delivery?.type!=='inline').map(row=>{
        if(typeof row.id!=='string'||!['mcp','plugin','bridge','model'].includes(row.kind)||typeof row.name!=='string'||typeof row.sourceRevision!=='string')throw failure();
        return {...row,revision:lock.sha256};
    });
    return {pin,revision:lock.sha256,manifest,metadata,read,historicalPins,plans,producerSha256:producer.sha256};
}

/** The checked producer closure binds runtime adapters/helpers as well as the human recipe revision. */
async function verifyBundledProducer(expected,directory=root){
    const producer=json(await checkedFile(directory,'catalog-source/producer.json',expected,128*1024));
    if(producer.schemaVersion!==1||!Array.isArray(producer.files)||!producer.files.length||producer.files.length>200)throw failure();
    let producerRoot=directory;
    try{await fs.lstat(path.join(producerRoot,'scripts/catalog-plugins/build.mjs'));}
    catch(error){if(error.code!=='ENOENT')throw error;producerRoot=path.join(directory,'tools');}
    const seen=new Set();let total=0;
    for(const file of producer.files){
        if(!relative(file.path)||seen.has(file.path)||!sha(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1024*1024)throw failure();
        seen.add(file.path);total+=file.bytes;if(total>5*1024*1024)throw failure();
        await checkedFile(producerRoot,file.path,file.sha256,file.bytes+1);
    }
    return producer;
}

/** Build input accepts a stable component identity and exact application revision, never a caller path or command. */
function validateBundledBuildSource(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['type','id','revision'].includes(key))
        ||value.type!=='bundled'||typeof value.id!=='string'||!/^(?:mcp|plugin)-[a-z0-9-]{1,120}$/.test(value.id)||!sha(value.revision))throw failure();
    return {type:'bundled',id:value.id,revision:value.revision};
}
async function bundledBuildRecipe(value,directory=root){
    const source=validateBundledBuildSource(value),bundle=await readBundledCatalog(directory);
    if(source.revision!==bundle.revision)throw Object.assign(new Error('Исходники каталога изменились после выбора. Обновите список перед новой сборкой; сохранённое задание не заменено.'),{code:'BUNDLED_SOURCE_CHANGED'});
    const plan=bundle.plans.find(row=>row.id===source.id);
    if(!plan||!['prepared','local-project'].includes(plan.delivery.type))throw Object.assign(new Error('Для этого компонента нужен явно выбранный локальный архив.'),{code:'BUNDLED_ARCHIVE_REQUIRED'});
    const filename=plan.delivery.recipe;if(!filename?.startsWith('catalog-source/'))throw failure();
    const recipe=json(await bundle.read(filename.slice('catalog-source/'.length)));
    if(recipe.key!==plan.id||recipe.kind!==plan.kind||recipe.revision!==plan.sourceRevision)throw failure();
    return {recipe,plan,recipePath:path.join(directory,filename),bundle};
}
/** A small separately pinned closure also survives retained producer snapshots without carrying metadata history. */
async function readBundledComponent(name,directory=root){
    const expected=lock.components?.[name];if(!sha(expected)||!/^[a-z0-9-]+$/.test(name))throw failure();
    const component=path.join(directory,'catalog-source/components',name),provenance=json(await checkedFile(component,'SOURCE.json',expected,128*1024));
    if(provenance.schemaVersion!==1||!Array.isArray(provenance.files)||provenance.files.length>50)throw failure();
    const files=new Map();let total=0;
    for(const file of provenance.files){
        if(files.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>1024*1024)throw failure();
        total+=file.bytes;if(total>2*1024*1024)throw failure();
        files.set(file.path,await checkedFile(component,file.path,file.sha256,file.bytes+1));
    }
    return {provenance,files};
}
module.exports={readBundledCatalog,validateBundledBuildSource,bundledBuildRecipe,readBundledComponent,verifyBundledProducer,checkedFile};
