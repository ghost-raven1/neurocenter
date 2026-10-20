'use strict';
const {portablePath}=require('./runtime-artifacts.cjs');
const {validateRuntimeSource}=require('./tool-runtime-source.cjs');
/** Internal execution plan references one checked local archive; public import remains asset.json. */
function validateArchiveSource(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['type','file','sha256','bytes','format','runtimeSource'].includes(key))||value.type!=='archive'||typeof value.file!=='string'||!portablePath(value.file)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>256*1024**2||!/^[a-f0-9]{64}$/.test(value.sha256??'')||!['zip','tar.gz','file'].includes(value.format))throw new Error('Локальный архив требует файл, SHA-256, размер и сгенерированный runtime.');
 const runtimeSource=validateRuntimeSource(value.runtimeSource);
 for(const bundle of Object.values(runtimeSource.assets))for(const asset of [bundle.app,bundle.runtime].filter(Boolean))if(asset.directory!=='.')throw new Error('Локальный архив использует только собственную готовую поставку.');
 return {type:'archive',file:value.file,sha256:value.sha256,bytes:value.bytes,format:value.format,runtimeSource};
}
module.exports={validateArchiveSource};
