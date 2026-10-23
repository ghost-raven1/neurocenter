'use strict';
const pin=require('./codex-connector-pin.json');
/** Only this immutable repository layout receives the auth-only model adapter. */
const CODEX_PLUGIN_SOURCE=Object.freeze({url:pin.repository,commit:pin.sourceCommit,subdirectory:'packages/bridge',entrypoint:'src/plugin.ts',adapter:'opencode-codex-bridge'});
function isPreparedCodexRepository(source){
 return !!source&&source.url===CODEX_PLUGIN_SOURCE.url&&source.commit===CODEX_PLUGIN_SOURCE.commit
  &&source.subdirectory===CODEX_PLUGIN_SOURCE.subdirectory&&(source.entrypoint===undefined||source.entrypoint===CODEX_PLUGIN_SOURCE.entrypoint)&&!source.runtimeSource;
}
const CODEX_MANAGED_INSTALL_MESSAGE='Коннектор Codex настраивается через «Настроить в OpenCode» в мастере провайдера; обычная установка плагина недоступна.';
/** Supply libraries activate only through an owned provider wrapper, never the generic plugin installer. */
function isManagedCodexConnectorPackage(value){
 const metadata=value?.config?.extra?.codexConnector,artifacts=value?.config?.extra?.runtimeArtifacts;
 return value?.plugin?.kind==='plugin'&&!!metadata&&typeof metadata==='object'&&!Array.isArray(metadata)
  &&Object.keys(metadata).sort().join(',')==='authOnly,schemaVersion,sdkVersion,sourceCommit,version'
  &&metadata.schemaVersion===1&&metadata.authOnly===true&&metadata.sourceCommit===pin.sourceCommit
  &&metadata.version===pin.version&&metadata.sdkVersion===pin.sdkVersion
  &&Array.isArray(artifacts)&&artifacts.length>0&&artifacts.every(artifact=>artifact?.entrypoint==='codex-plugin.mjs');
}
module.exports={CODEX_PLUGIN_SOURCE,isPreparedCodexRepository,CODEX_MANAGED_INSTALL_MESSAGE,isManagedCodexConnectorPackage};
