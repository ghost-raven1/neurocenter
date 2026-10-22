'use strict';
const pin=require('./codex-connector-pin.json');
/** Only this immutable repository layout receives the auth-only model adapter. */
const CODEX_PLUGIN_SOURCE=Object.freeze({url:pin.repository,commit:pin.sourceCommit,subdirectory:'packages/bridge',entrypoint:'src/plugin.ts',adapter:'opencode-codex-bridge'});
function isPreparedCodexRepository(source){
 return !!source&&source.url===CODEX_PLUGIN_SOURCE.url&&source.commit===CODEX_PLUGIN_SOURCE.commit
  &&source.subdirectory===CODEX_PLUGIN_SOURCE.subdirectory&&(source.entrypoint===undefined||source.entrypoint===CODEX_PLUGIN_SOURCE.entrypoint)&&!source.runtimeSource;
}
module.exports={CODEX_PLUGIN_SOURCE,isPreparedCodexRepository};
