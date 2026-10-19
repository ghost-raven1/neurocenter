'use strict';

/** Только зарегистрированные переключатели: дополнительные ключи и таргетинг не поддерживаются. */
const FEATURE_FLAGS=Object.freeze([
    {key:'model_hosting',name:'Хостинг моделей',description:'Запуск, проверка и использование моделей на сервере.',defaultEnabled:true},
    {key:'tool_builds',name:'Сборка инструментов',description:'Подготовка готовых комплектов плагинов и MCP из исходного кода.',defaultEnabled:true},
    {key:'rag_sync',name:'Синхронизация базы знаний',description:'Передача и обновление индекса базы знаний проекта.',defaultEnabled:true},
].map(flag=>Object.freeze(flag)));
const FEATURE_FLAG_KEYS=Object.freeze(FEATURE_FLAGS.map(flag=>flag.key));
const isFeatureFlagKey=value=>typeof value==='string'&&FEATURE_FLAG_KEYS.includes(value);
const defaultFeatureFlags=()=>Object.fromEntries(FEATURE_FLAGS.map(flag=>[flag.key,flag.defaultEnabled]));

module.exports={FEATURE_FLAGS,FEATURE_FLAG_KEYS,isFeatureFlagKey,defaultFeatureFlags};
