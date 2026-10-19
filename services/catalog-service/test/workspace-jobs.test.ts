import { describe, expect, it } from 'vitest';
import { assertWorkspaceSource, assertWorkspacePreparation } from '../src/devices/workspace-jobs';

describe('Серверный контракт экземпляра папки', () => {
    const bindingId = 'a'.repeat(64);
    const instanceId = '11111111-1111-4111-8111-111111111111';
    const report = {capabilities:['workspace-instance-v1'],bindings:[{projectId:'project',bindingId,instanceId,valid:true}]};
    it('Новая папка доступна только клиенту с поддержкой экземпляров', () => {
        expect(() => assertWorkspaceSource(report,'project','new')).not.toThrow();
        expect(() => assertWorkspaceSource({bridgeVersion:'0.7.0'},'project','new')).toThrow('Обновите');
    });
    it.each(['new-copy','transfer'])('Действие %s закрепляет исходный binding и instance', mode => {
        expect(() => assertWorkspaceSource(report,'project',mode,bindingId,instanceId)).not.toThrow();
        expect(() => assertWorkspaceSource(report,'project',mode,'b'.repeat(64),instanceId)).toThrow();
        expect(() => assertWorkspaceSource(report,'project',mode,bindingId,'22222222-2222-4222-8222-222222222222')).toThrow();
        expect(() => assertWorkspaceSource({...report,bindings:[{...report.bindings[0],valid:false}]},'project',mode,bindingId,instanceId)).toThrow();
    });
    it('Legacy миграция использует только явно выбранное происхождение', () => {
        const legacy = {...report,bindings:[{projectId:'project',previousBindingId:bindingId,valid:false,identityStatus:'legacy'}]};
        expect(() => assertWorkspaceSource(legacy,'project','adopt-legacy',bindingId)).not.toThrow();
        expect(() => assertWorkspaceSource(legacy,'project','transfer',bindingId,instanceId)).toThrow();
    });
    it('Переименование допускает только перенос прежнего экземпляра, без разрешения на установку в исчезнувший путь', () => {
        const missing = {...report,bindings:[{projectId:'project',previousBindingId:bindingId,instanceId,valid:false,identityStatus:'unavailable'}]};
        expect(() => assertWorkspaceSource(missing,'project','transfer',bindingId,instanceId)).not.toThrow();
        expect(() => assertWorkspaceSource(missing,'project','new-copy',bindingId,instanceId)).toThrow();
    });
    it('Preview не передаёт абсолютные пути, содержимое или физический fingerprint', () => {
        const preview = {projectId:'project',folderName:'проект',mode:'transfer',preparation:'d'.repeat(64),requiresFileVerification:true,
            instanceId,previousBindingId:bindingId,expectedBindingId:bindingId,expectedInstanceId:instanceId};
        expect(() => assertWorkspacePreparation(preview,{projectId:'project',folderName:'проект',mode:'transfer'})).not.toThrow();
        for (const extra of [{root:'/Users/private'},{dev:12},{files:[]},{sourceFolderName:'../secret'},{requiresFileVerification:false}]) {
            expect(() => assertWorkspacePreparation({...preview,...extra},{projectId:'project',folderName:'проект',mode:'transfer'})).toThrow();
        }
    });
});
