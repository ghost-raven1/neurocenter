'use strict';

/** Только зарегистрированные переключатели: дополнительные ключи и таргетинг не поддерживаются. */
const FEATURE_FLAGS=Object.freeze(require('./feature-flag-catalog.json').map(flag=>Object.freeze({...flag,dependsOn:Object.freeze([...flag.dependsOn])})));
const FEATURE_FLAG_KEYS=Object.freeze(FEATURE_FLAGS.map(flag=>flag.key));
const isFeatureFlagKey=value=>typeof value==='string'&&FEATURE_FLAG_KEYS.includes(value);
const defaultFeatureFlags=()=>Object.fromEntries(FEATURE_FLAGS.map(flag=>[flag.key,flag.defaultEnabled]));
/** Dependencies affect effective values without overwriting the administrator's own switches. */
function evaluateFeatureFlags(configured){
    if(!configured||typeof configured!=='object'||Array.isArray(configured)||FEATURE_FLAG_KEYS.some(key=>typeof configured[key]!=='boolean'))throw new TypeError('Incomplete feature configuration.');
    const flags={},blockedBy={},visiting=new Set();
    const visit=key=>{
        if(key in flags)return flags[key];
        if(visiting.has(key))throw new TypeError('Cyclic feature dependency.');visiting.add(key);
        const definition=FEATURE_FLAGS.find(flag=>flag.key===key);if(!definition)throw new TypeError('Unknown feature dependency.');
        const blocked=[];
        for(const dependency of definition.dependsOn){if(!visit(dependency))blocked.push(...(!configured[dependency]?[dependency]:blockedBy[dependency]));}
        blockedBy[key]=[...new Set(blocked)];flags[key]=configured[key]&&blocked.length===0;visiting.delete(key);return flags[key];
    };
    FEATURE_FLAG_KEYS.forEach(visit);
    return {flags,configured:Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,configured[key]])),blockedBy};
}
/** Trust only a complete boolean decision; calculate dependencies again at every execution boundary. */
function parseEvaluatedFeatureFlags(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||!value.flags)throw new TypeError('Invalid feature decision.');
    const effective=evaluateFeatureFlags(value.configured===undefined?value.flags:value.configured);
    if(FEATURE_FLAG_KEYS.some(key=>typeof value.flags[key]!=='boolean'||effective.flags[key]!==value.flags[key]))throw new TypeError('Inconsistent feature decision.');
    // Permission consumers receive no configured/audit metadata. The full map remains mandatory.
    return {flags:effective.flags,blockedBy:effective.blockedBy};
}

evaluateFeatureFlags(defaultFeatureFlags());
module.exports={FEATURE_FLAGS,FEATURE_FLAG_KEYS,isFeatureFlagKey,defaultFeatureFlags,evaluateFeatureFlags,parseEvaluatedFeatureFlags};
