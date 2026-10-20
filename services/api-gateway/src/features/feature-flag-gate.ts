import type {AxiosInstance} from 'axios';
import {FEATURE_FLAGS,type FeatureFlagKey} from '../../../shared/feature-flags.cjs';
import {canonicalAccessRoute} from '../../../shared/access-route.cjs';

interface IFlagFailure {status:403|503;code:string;message:string;feature?:FeatureFlagKey;}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Ограничиваются новые тяжёлые запросы; просмотр результатов и освобождение памяти доступны всегда. */
export function requiredFeatureFlag(method:string,rawPath:string,body:unknown):FeatureFlagKey|undefined {
    const route=canonicalAccessRoute(rawPath),verb=method.toUpperCase();
    if(!route)return;
    if(verb==='POST'&&/^\/api\/models\/[^/]+\/ollama\/(api\/(embed|chat)|v1\/(embeddings|chat\/completions))$/.test(route))return 'model_hosting';
    if(verb==='POST'&&/^\/api\/models\/[^/]+\/hosting$/.test(route)&&object(body)&&typeof body.action==='string'&&['start','check'].includes(body.action))return 'model_hosting';
    if((verb==='POST'&&['/api/tool-builds','/api/tool-builds/archive'].includes(route))
        ||(verb==='POST'&&route==='/api/tool-builds/uploads')
        ||(verb==='PUT'&&/^\/api\/tool-builds\/uploads\/[^/]+\/content$/.test(route))
        ||(['GET','HEAD'].includes(verb)&&/^\/api\/tool-builds\/(npm|repository)$/.test(route)))return 'tool_builds';
    if(verb==='POST'&&(route==='/api/rag/sync'||route==='/api/device-jobs'&&object(body)&&body.kind==='sync-rag'))return 'rag_sync';
}

/** Решение читается без кеша после RBAC: сбой флагового сервиса не разрешает тяжёлый запрос. */
export async function featureFlagFailure(http:Pick<AxiosInstance,'get'>,base:string,key:FeatureFlagKey):Promise<IFlagFailure|undefined> {
    try {
        const response=await http.get<unknown>(base+'/internal/feature-flags/evaluated',{
            headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},timeout:3000,
            maxContentLength:64*1024,maxRedirects:0,
        });
        const data=response.data;
        if(response.status!==200||!object(data)||!object(data.flags)||FEATURE_FLAGS.some(flag=>typeof (data.flags as Record<string,unknown>)[flag.key]!=='boolean'))throw new Error('invalid-feature-flags');
        if(data.flags[key]===false) {
            const name=FEATURE_FLAGS.find(flag=>flag.key===key)!.name;
            return {status:403,code:'feature-disabled',feature:key,message:`Функция «${name}» отключена главным администратором.`};
        }
    } catch {
        return {status:503,code:'feature-flags-unavailable',message:'Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.'};
    }
}
