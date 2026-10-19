'use strict';
const {TARGETS}=require('./runtime-artifacts.cjs');

/** Совместимая поставка привязана к исходному commit MrDoe и опубликованной версии npm. */
const RAG_PLUGIN_SOURCE=Object.freeze({
 url:'https://github.com/mrdoe/opencoderag',commit:'4fb269c6f23a99701c7ac70fcc3f3e483c9f13ff',
 entrypoint:'src/plugin.ts',version:'2.4.4',adapter:'opencode-rag-plugin',
 supportedTargets:Object.freeze(TARGETS.filter(target=>target!=='darwin-x64')),
});

/** Другой commit, подпапка или точка входа не подменяются подготовленным пакетом. */
function isPreparedRagRepository(source){
 return !!source&&source.url===RAG_PLUGIN_SOURCE.url&&source.commit===RAG_PLUGIN_SOURCE.commit
  &&!source.subdirectory&&(source.entrypoint===undefined||source.entrypoint===RAG_PLUGIN_SOURCE.entrypoint);
}
module.exports={RAG_PLUGIN_SOURCE,isPreparedRagRepository};
