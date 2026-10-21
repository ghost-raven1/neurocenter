'use strict';

const TOOL_SOURCE_MAX_BYTES=256*1024*1024;
const checkedSha=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new TypeError('Нужен точный SHA-256 файла поставки.');return value;};
/** The same envelope always locates its opaque source and immutable runtime bytes by SHA. */
const toolRuntimePath=sha=>'artifacts/'+checkedSha(sha)+'.tar.gz';
const toolSourcePath=sha=>'source/'+checkedSha(sha)+'.source';
/** A public recipe cannot shadow another role's different bytes or a transport document. */
function assertToolSupplyLayout(asset){
    const paths=new Map([['asset.json',{name:'asset.json',sha:'descriptor'}],['readme.md',{name:'README.md',sha:'readme'}]]);
    const add=(name,sha)=>{const key=name.normalize('NFC').toLowerCase();for(const [known,saved]of paths){if(known===key&&saved.sha===sha&&saved.name===name)return;if(known===key||known.startsWith(key+'/')||key.startsWith(known+'/'))throw new Error('Пути ролей поставки конфликтуют.');}paths.set(key,{name,sha});};
    const artifacts=asset.kind==='skill'&&asset.delivery.type==='inline'?[]:asset.delivery.artifacts;
    if(!Array.isArray(artifacts))throw new Error('Неподдерживаемая доставка ассета.');
    for(const {descriptor}of artifacts)add(toolRuntimePath(descriptor.sha256),descriptor.sha256);
    if(asset.source.type==='archive')add(toolSourcePath(asset.source.sha256),asset.source.sha256);
    if(asset.recipe)add(asset.recipe.path,asset.recipe.sha256);
}
module.exports={TOOL_SOURCE_MAX_BYTES,toolRuntimePath,toolSourcePath,assertToolSupplyLayout};
