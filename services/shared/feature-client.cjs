'use strict';
const {FEATURE_FLAGS,isFeatureFlagKey,parseEvaluatedFeatureFlags}=require('./feature-flags.cjs');

/** Public structured errors contain no service URLs, credentials or upstream bodies. */
class FeatureFlagError extends Error{
    constructor(status,code,message,feature,blockedBy=[]){super(message);this.name='FeatureFlagError';this.status=status;this.code=code;this.feature=feature;this.blockedBy=blockedBy;}
}
const unavailable=()=>new FeatureFlagError(503,'feature-flags-unavailable','Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.');
async function readFeatures(env=process.env,request=globalThis.fetch,signal){
    try{
        const base=(env.FEATURE_FLAGS_SERVICE_URL||'http://127.0.0.1:4400').replace(/\/+$/,'');
        const response=await request(base+'/internal/feature-flags/evaluated',{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(3000),...(signal?[signal]:[])]),
            headers:{'x-neurocenter-internal':env.NEUROCENTER_INTERNAL_TOKEN||''}});
        if(!response.ok){await response.body?.cancel();throw unavailable();}
        let bytes=0;const chunks=[];
        for await(const chunk of response.body){bytes+=chunk.length;if(bytes>64*1024)throw unavailable();chunks.push(chunk);}
        return parseEvaluatedFeatureFlags(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch(error){if(signal?.aborted)throw signal.reason;if(error instanceof FeatureFlagError)throw error;throw unavailable();}
}
/** One uncached bounded lookup for every required capability; an empty recovery policy performs no I/O. */
async function requireFeaturesEnabled(keys,env=process.env,request=globalThis.fetch,signal){
    if(!Array.isArray(keys)||keys.some(key=>!isFeatureFlagKey(key)))throw new TypeError('Unknown feature requirement.');
    if(!keys.length)return;
    const evaluated=await readFeatures(env,request,signal),key=keys.find(key=>!evaluated.flags[key]);
    if(key){const flag=FEATURE_FLAGS.find(flag=>flag.key===key);throw new FeatureFlagError(403,'feature-disabled',`Функция «${flag.name}» отключена главным администратором.`,key,evaluated.blockedBy[key]);}
}
module.exports={FeatureFlagError,readFeatures,requireFeaturesEnabled};
