import type {AxiosInstance} from 'axios';
import {FEATURE_FLAGS,parseEvaluatedFeatureFlags,type FeatureFlagKey} from '../../../shared/feature-flags.cjs';
export {requiredRouteFeatures as requiredFeatureFlags} from '../../../shared/feature-policy.cjs';

interface IFlagFailure {status:403|503;code:string;message:string;feature?:FeatureFlagKey;blockedBy?:FeatureFlagKey[]}
/** Admission reads one complete uncached decision after RBAC; historical reads never depend on this transport. */
export async function featureFlagsFailure(http:Pick<AxiosInstance,'get'>,base:string,keys:readonly FeatureFlagKey[]):Promise<IFlagFailure|undefined>{
    if(!keys.length)return;
    try{
        const response=await http.get<unknown>(base+'/internal/feature-flags/evaluated',{headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},timeout:3000,maxContentLength:64*1024,maxRedirects:0});
        if(response.status!==200)throw new Error('flags-unavailable');
        const evaluated=parseEvaluatedFeatureFlags(response.data),key=keys.find(key=>!evaluated.flags[key]);
        if(key)return {status:403,code:'feature-disabled',feature:key,blockedBy:evaluated.blockedBy[key],message:`Функция «${FEATURE_FLAGS.find(flag=>flag.key===key)!.name}» отключена главным администратором.`};
    }catch{return {status:503,code:'feature-flags-unavailable',message:'Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.'};}
}
