import {describe,expect,it} from 'vitest';
import type {IBridgeInstallation} from '../src/features/McpBridge/api';
import type {ILocalChangePlan} from '../src/features/McpBridge/operationTypes';
import {prepareSelectedRestore,receiveRestorePreview,restoreSelectionCanApply,restoreSelectionPrepared,selectRestorePaths} from '../src/features/McpBridge/localRestoreSelection';

const sha='a'.repeat(64);const first='.opencode/skills/tool/SKILL.md';const second='.opencode/skills/tool/references/info.md';
const row:IBridgeInstallation={deviceId:'device',projectId:'project',assetId:'skill/tool',assetKind:'skill',name:'Инструкция',version:2,manifest:sha,bindingId:sha,updatedAt:'2026-10-18T00:00:00.000Z'};
const plan:ILocalChangePlan={schemaVersion:1,planId:'11111111-1111-1111-1111-111111111111',revision:1,digest:sha,projectId:'project',bindingId:sha,
    instanceId:'22222222-2222-2222-2222-222222222222',assetId:row.assetId,assetKind:'skill',version:2,manifest:sha,
    checkedAt:row.updatedAt,expiresAt:'2026-10-18T00:15:00.000Z',status:'prepared',files:[first,second].map(path=>({path,operation:'replace',beforeSha256:sha,afterSha256:'b'.repeat(64),beforeBytes:10,afterBytes:20,binary:false}))};
const initial=()=>receiveRestorePreview(undefined,plan,'context','recovery');

describe('Явный выбор возвращаемых файлов',()=>{
    it('Первое полное сравнение выбирает все файлы без автоматического согласия',()=>{
        const state=initial();expect(state.paths).toEqual([first,second]);expect(state.fullFiles).toBe(plan.files);
        expect(restoreSelectionPrepared(state,'context')).toBe(true);expect(restoreSelectionCanApply(state,'context')).toBe(false);
    });
    it('Подмножество отправляется новым prepare с прежним recovery и installed tuple',()=>{
        const selected=selectRestorePaths(initial(),[second]);const prepared=prepareSelectedRestore(row,selected,'context');
        expect(prepared.input).toEqual({kind:'prepare-local-restore',deviceId:row.deviceId,projectId:row.projectId,assetId:row.assetId,assetKind:row.assetKind,
            expectedManifest:sha,expectedBindingId:sha,recoveryId:'recovery',restorePaths:[second]});
        expect(prepared.input).not.toHaveProperty('changePlanId');expect(prepared.selection.confirmed).toBe(false);
    });
    it('Изменение галочек блокирует применение старого плана даже при прежнем согласии',()=>{
        const state={...initial(),confirmed:true};expect(restoreSelectionCanApply(state,'context')).toBe(true);
        const selected=selectRestorePaths(state,[second]);expect(selected.confirmed).toBe(false);
        expect(restoreSelectionPrepared(selected,'context')).toBe(false);
        expect(restoreSelectionCanApply({...selected,confirmed:true},'context')).toBe(false);
    });
    it('Новая подготовка того же набора сбрасывает согласие, новый preview тоже требует согласия',()=>{
        const state={...initial(),confirmed:true};const preparing=prepareSelectedRestore(row,state,'context');
        expect(preparing.selection.confirmed).toBe(false);expect(restoreSelectionCanApply(preparing.selection,'context')).toBe(false);
        const received=receiveRestorePreview(preparing.selection,{...plan,planId:'33333333-3333-3333-3333-333333333333'},'context','recovery',[first,second]);
        expect(received.confirmed).toBe(false);expect(restoreSelectionCanApply(received,'context')).toBe(false);
    });
    it('После preview подмножества сохраняет исходный список для возвращения исключённых файлов',()=>{
        const selected=selectRestorePaths(initial(),[second]);const subset={...plan,files:[plan.files[1]],digest:'c'.repeat(64)};
        const received=receiveRestorePreview(selected,subset,'context','recovery',[second]);
        expect(received.fullFiles.map(file=>file.path)).toEqual([first,second]);expect(received.plan.files.map(file=>file.path)).toEqual([second]);
        expect(restoreSelectionPrepared(received,'context')).toBe(true);
        const reselected=selectRestorePaths(received,[first,second]);expect(prepareSelectedRestore(row,reselected,'context').input).toHaveProperty('restorePaths',[first,second]);
        expect(restoreSelectionCanApply({...reselected,confirmed:true},'context')).toBe(false);
    });
    it('Нулевой набор, неизвестный путь и новый контекст не отправляются и не применяются',()=>{
        expect(()=>prepareSelectedRestore(row,selectRestorePaths(initial(),[]),'context')).toThrow('хотя бы один');
        expect(()=>selectRestorePaths(initial(),['opencode.json'])).toThrow('неизвестный');
        expect(()=>prepareSelectedRestore(row,{...initial(),paths:[first,first]},'context')).toThrow();
        expect(()=>prepareSelectedRestore(row,initial(),'new-context')).toThrow();
        expect(restoreSelectionCanApply({...initial(),confirmed:true},'new-context')).toBe(false);
    });
    it('Смена варианта или исходного состояния начинает новый полный список без старого выбора',()=>{
        const selected=selectRestorePaths(initial(),[second]);const newPlan={...plan,files:[plan.files[0]]};
        for(const [context,recovery] of [['new-context','recovery'],['context','other-recovery']]){
            const received=receiveRestorePreview(selected,newPlan,context,recovery);
            expect(received.fullFiles.map(file=>file.path)).toEqual([first]);expect(received.paths).toEqual([first]);expect(received.confirmed).toBe(false);
        }
    });
    it('Ответ с иным набором не разрешает тихое частичное восстановление',()=>{
        expect(()=>receiveRestorePreview(initial(),{...plan,files:[plan.files[1]]},'context','recovery',[first,second])).toThrow('Состав файлов изменился');
    });
});
