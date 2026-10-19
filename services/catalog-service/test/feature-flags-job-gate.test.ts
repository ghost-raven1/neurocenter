import {describe,expect,it,vi} from 'vitest';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';

describe('Серверная проверка флага перед постановкой задания',()=>{
    const env={FEATURE_FLAGS_SERVICE_URL:'http://flags.test',NEUROCENTER_INTERNAL_TOKEN:'fixture-token'};
    const flags={model_hosting:true,tool_builds:true,rag_sync:true};
    it('Читает подтверждённое значение без кеша через служебный адрес',async()=>{
        const request=vi.fn(async()=>new Response(JSON.stringify({flags})));
        await requireFeatureEnabled('rag_sync',env,request as typeof fetch);
        expect(request).toHaveBeenCalledWith('http://flags.test/internal/feature-flags/evaluated',expect.objectContaining({redirect:'error',headers:{'x-neurocenter-internal':'fixture-token'}}));
    });
    it('Выключенное значение даёт отказ до изменения очереди',async()=>{
        await expect(requireFeatureEnabled('rag_sync',env,async()=>new Response(JSON.stringify({flags:{...flags,rag_sync:false}})))).rejects.toHaveProperty('status',403);
    });
    it.each([null,{flags:{}},{flags:{...flags,rag_sync:'true'}}])('Повреждённый ответ не разрешает новое задание',async value=>{
        await expect(requireFeatureEnabled('rag_sync',env,async()=>new Response(JSON.stringify(value)))).rejects.toHaveProperty('status',503);
    });
    it('Отказ и недоступность сервиса не подменяются разрешённым значением',async()=>{
        await expect(requireFeatureEnabled('rag_sync',env,async()=>new Response('{}',{status:503}))).rejects.toHaveProperty('status',503);
        await expect(requireFeatureEnabled('rag_sync',env,async()=>{throw new Error('private-url');})).rejects.toThrow('Не удалось проверить доступность');
    });
});
