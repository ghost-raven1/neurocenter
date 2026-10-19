import { describe, expect, it } from 'vitest';
import { assertRuntimeProbe, type RuntimeProbeResult } from '../src/devices/runtime-probe';

describe('Безопасный результат проверки запуска', () => {
    const source = {projectId:'project',bindingId:'b'.repeat(64),consentManifest:'a'.repeat(64),
        package:{plugin:{id:'skill',kind:'skill',version:1},manifest:{sha256:'a'.repeat(64)},files:[{}]}};
    const result: RuntimeProbeResult = {schemaVersion:1,projectId:'project',bindingId:source.bindingId,assetId:'skill',assetKind:'skill',version:1,
        manifest:source.consentManifest,approvalManifest:source.consentManifest,checkedAt:'2026-10-17T12:00:00.000Z',engineVersion:'1.14.48',engineSha256:'c'.repeat(64),
        status:'passed',code:'verified',counts:{packages:1,files:1,skills:1,mcp:0,tools:0,resources:0,prompts:0,pluginsInitialized:0}};
    it('Принимает проверку точной установки и область выполненных действий', () => { expect(() => assertRuntimeProbe(result,source)).not.toThrow(); });
    it.each([{stdout:'секрет'},{config:{token:'секрет'}},{bindingId:'d'.repeat(64)},{manifest:'e'.repeat(64)},
        {approvalManifest:'f'.repeat(64)},{engineVersion:'latest'},{engineSha256:''},{code:'plugin-works-forever'},{status:'ready'}])('Отвергает утечку или подмену результата: %j', changed => {
        expect(() => assertRuntimeProbe({...result,...changed},source)).toThrow();
    });
    it('Ошибка не может обещать успешный запуск', () => { expect(() => assertRuntimeProbe(result,source,true)).toThrow(); });
    it('Неполные или бесконечные счётчики не принимаются', () => {
        for (const counts of [{...result.counts,packages:2},{...result.counts,tools:Infinity},{...result.counts,logs:'секрет'}]) {
            expect(() => assertRuntimeProbe({...result,counts},source)).toThrow();
        }
    });
    it('Отсутствующий runtime явно отмечается как неподдерживаемый', () => {
        expect(() => assertRuntimeProbe({...result,status:'unsupported',code:'runtime-unavailable',engineSha256:'',
            counts:{packages:0,files:0,skills:0,mcp:0,tools:0,resources:0,prompts:0,pluginsInitialized:0}},source)).not.toThrow();
    });
    it('Успех части графа не подтверждает весь одобренный набор', () => {
        const setSource={...source,installSet:{packages:[source.package,{...source.package,plugin:{id:'mcp',kind:'mcp',version:1}}]}};
        expect(()=>assertRuntimeProbe(result,setSource)).toThrow('весь закреплённый набор');
        expect(()=>assertRuntimeProbe({...result,counts:{...result.counts,packages:2,files:2,mcp:1}},setSource)).not.toThrow();
    });
});
