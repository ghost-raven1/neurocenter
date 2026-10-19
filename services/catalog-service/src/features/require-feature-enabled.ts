import {ForbiddenException,ServiceUnavailableException} from '@nestjs/common';
import {FEATURE_FLAGS,type FeatureFlagKey} from '../../../shared/feature-flags.cjs';

/** Общая точка постановки заданий закрывает также повтор из сохранённого payload. */
export async function requireFeatureEnabled(key:FeatureFlagKey,env=process.env,request=globalThis.fetch):Promise<void> {
    try {
        const base=(env.FEATURE_FLAGS_SERVICE_URL||'http://127.0.0.1:4400').replace(/\/+$/,'');
        const response=await request(base+'/internal/feature-flags/evaluated',{redirect:'error',signal:AbortSignal.timeout(3000),
            headers:{'x-neurocenter-internal':env.NEUROCENTER_INTERNAL_TOKEN||''}});
        if(!response.ok){await response.body?.cancel();throw new Error('flags-unavailable');}
        const value=await response.json() as {flags?:Record<string,unknown>}|null;
        if(!value?.flags||FEATURE_FLAGS.some(flag=>typeof value.flags?.[flag.key]!=='boolean'))throw new Error('invalid-flags');
        if(value.flags[key]===false)throw new ForbiddenException(`Функция «${FEATURE_FLAGS.find(flag=>flag.key===key)!.name}» отключена главным администратором.`);
    } catch(error) {
        if(error instanceof ForbiddenException)throw error;
        throw new ServiceUnavailableException('Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.');
    }
}
