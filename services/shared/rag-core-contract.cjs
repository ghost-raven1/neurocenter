'use strict';
const {localRagUi}=require('./rag-ui-contract.cjs');
const fixed=()=>({schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'});
/** Fixed managed engine ABI, independent of its optional UI. Explicit invalid core metadata never falls back. */
function localRagCore(pkg){
 const extra=pkg?.config?.extra,value=extra?.ragCore;
 if(value===undefined)return localRagUi(pkg)?fixed():undefined;
 const hosted=extra?.hostedEmbedding;
 if(pkg.schemaVersion!==5||!['mcp','plugin'].includes(pkg.plugin?.kind)||pkg.config?.transport==='remote'
  ||!Array.isArray(extra?.runtimeArtifacts)||!extra.runtimeArtifacts.length
  ||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='application,entrypoint,schemaVersion'
  ||value.schemaVersion!==1||value.application!=='opencode-rag'||value.entrypoint!=='opencode-rag.mjs'
  ||!hosted||typeof hosted!=='object'||Array.isArray(hosted)||Object.keys(hosted).sort().join(',')!=='profileSchemaVersion,reindexSchemaVersion,schemaVersion'
  ||hosted.schemaVersion!==1||hosted.profileSchemaVersion!==2||hosted.reindexSchemaVersion!==1)
  throw new Error('Эта версия не содержит поддерживаемого ядра OpenCodeRAG. Обновите инструмент.');
 return fixed();
}
module.exports={localRagCore};
