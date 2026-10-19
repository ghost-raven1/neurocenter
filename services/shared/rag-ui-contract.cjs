'use strict';
const ARGS=Object.freeze(['ui','--port','0','--no-open']);
/** Только закреплённый локальный Web UI OpenCodeRAG; произвольные команды не поддерживаются. */
function localRagUi(pkg){
 const value=pkg?.config?.extra?.localUi;
 if(value===undefined)return undefined;
 if(pkg.schemaVersion!==5||!['mcp','plugin'].includes(pkg.plugin?.kind)||pkg.config?.transport==='remote'
  ||!Array.isArray(pkg.config?.extra?.runtimeArtifacts)||!pkg.config.extra.runtimeArtifacts.length
  ||!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join(',')!=='application,args,entrypoint,schemaVersion'
  ||value.schemaVersion!==1||value.application!=='opencode-rag'||value.entrypoint!=='opencode-rag.mjs'
  ||JSON.stringify(value.args)!==JSON.stringify(ARGS))throw new Error('Эта версия не содержит поддерживаемого интерфейса OpenCodeRAG. Обновите инструмент.');
 return {schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:[...ARGS]};
}
/** Адрес готовности принимается только из собственного IPC, без внешних хостов и query-секретов. */
function ragUiReady(value){
 const match=typeof value?.url==='string'&&value.url.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/#neurocenter-token=[a-f0-9]{48}$/);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='port,type,url'
  ||value.type!=='neurocenter-rag-ui-ready'||!Number.isInteger(value.port)||value.port<1||value.port>65535
  ||!match||Number(match[1])!==value.port)throw new Error('Локальный интерфейс не подтвердил безопасную готовность.');
 return {url:value.url,port:value.port};
}
module.exports={localRagUi,ragUiReady};
