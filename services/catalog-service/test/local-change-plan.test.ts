import { describe, expect, it } from 'vitest';
import { assertLocalChangePlan, type LocalChangePlan } from '../src/devices/local-change-plan';

describe('План изменений передаёт только метаданные текущего экземпляра', () => {
    const checkedAt = '2026-10-17T12:00:00.000Z';
    const source = { projectId:'project',bindingId:'b'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',
        package:{plugin:{id:'skill',kind:'skill',version:1},manifest:{sha256:'a'.repeat(64)}} };
    const plan: LocalChangePlan = {schemaVersion:1,planId:'22222222-2222-4222-8222-222222222222',revision:1,digest:'d'.repeat(64),
        projectId:'project',bindingId:source.bindingId,instanceId:source.instanceId,assetId:'skill',assetKind:'skill',version:1,
        manifest:source.package.manifest.sha256,checkedAt,expiresAt:'2026-10-17T12:15:00.000Z',status:'prepared',
        files:[{path:'.opencode/skills/skill/SKILL.md',operation:'replace',beforeSha256:'c'.repeat(64),afterSha256:'a'.repeat(64),beforeBytes:10,afterBytes:12,binary:false}]};
    it('Принимает точные хэши, размеры и относительный путь', () => { expect(() => assertLocalChangePlan(plan,source)).not.toThrow(); });
    it('Принимает явное восстановление runtime без изменений файлов проекта',()=>{
        expect(()=>assertLocalChangePlan({...plan,files:[],runtimeRepairRequired:true},source)).not.toThrow();
        expect(()=>assertLocalChangePlan({...plan,files:[]},source)).not.toThrow();
    });
    it.each([false,undefined,'true',1,{},[]])('Не расширяет контракт неявным флагом восстановления: %j',runtimeRepairRequired=>{
        expect(()=>assertLocalChangePlan({...plan,runtimeRepairRequired},source)).toThrow();
    });
    it('Даже восстановление runtime не передаёт приватные пути и содержимое кэша',()=>{
        for(const changed of [{cachePath:'/Users/private/cache'},{runtimeBytes:'секрет'}]){
            expect(()=>assertLocalChangePlan({...plan,files:[],runtimeRepairRequired:true,...changed},source)).toThrow();
        }
    });
    it.each([
        {content:'секрет'}, {reportPath:'/Users/private/diff.html'}, {instanceId:'33333333-3333-4333-8333-333333333333'},
        {bindingId:'e'.repeat(64)}, {manifest:'f'.repeat(64)}, {version:2}, {revision:2},
        {expiresAt:'2026-10-17T13:00:00.000Z'}, {checkedAt:'не дата'},
    ])('Отвергает утечку или подмену плана: %j', changed => { expect(() => assertLocalChangePlan({...plan,...changed},source)).toThrow(); });
    it.each(['/etc/passwd','../secret','.opencode/../secret','C:\\secret','folder/./secret','folder//secret'])('Отвергает опасный путь %s', path => {
        expect(() => assertLocalChangePlan({...plan,files:[{...plan.files[0],path}]},source)).toThrow();
    });
    it('Отвергает коллизии регистра и дополнительные поля файла', () => {
        expect(() => assertLocalChangePlan({...plan,files:[plan.files[0],{...plan.files[0],path:plan.files[0].path.toUpperCase()}]},source)).toThrow();
        expect(() => assertLocalChangePlan({...plan,files:[{...plan.files[0],before:'секрет'}]},source)).toThrow();
    });
    it('Не принимает несогласованное добавление или отрицательные размеры', () => {
        for (const changed of [{operation:'add'},{operation:'remove'},{beforeBytes:-1},{afterBytes:5*1024*1024}]) {
            expect(() => assertLocalChangePlan({...plan,files:[{...plan.files[0],...changed}]},source)).toThrow();
        }
    });
});
