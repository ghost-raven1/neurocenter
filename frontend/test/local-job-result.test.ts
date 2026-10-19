import {describe,expect,it} from 'vitest';
import {consumeLocalJobResult} from '../src/features/McpBridge/localJobResult';
import {receiveRestorePreview,restoreSelectionCanApply} from '../src/features/McpBridge/localRestoreSelection';
import type {ILocalChangePlan} from '../src/features/McpBridge/operationTypes';

const plan:ILocalChangePlan={schemaVersion:1,planId:'11111111-1111-1111-1111-111111111111',revision:1,digest:'a'.repeat(64),projectId:'project',
    bindingId:'b'.repeat(64),instanceId:'22222222-2222-2222-2222-222222222222',assetId:'tool',assetKind:'skill',version:1,manifest:'c'.repeat(64),
    checkedAt:'2026-10-18T00:00:00.000Z',expiresAt:'2026-10-18T00:15:00.000Z',status:'prepared',files:[{path:'.opencode/skills/tool/SKILL.md',
        operation:'replace',beforeSha256:'d'.repeat(64),afterSha256:'e'.repeat(64),beforeBytes:10,afterBytes:20,binary:false}]};

describe('Однократное принятие результата локального задания',()=>{
    it('Повтор polling/WS с новым объектом результата не переустанавливает preview и не снимает согласие принятия',()=>{
        const seen=new Set<string>();let confirmed=false;let displayed:ILocalChangePlan|undefined;
        const deliver=(job:{id:string;state:string;result:ILocalChangePlan})=>{
            if(!consumeLocalJobResult(seen,job,'binding/scan/approved-version','binding/scan/approved-version'))return;
            displayed=job.result;confirmed=false;
        };
        const first={id:'prepare-adopt',state:'succeeded',result:plan};deliver(first);confirmed=true;
        deliver(structuredClone(first));deliver({...first,result:{...plan}});
        expect(displayed).toBe(plan);expect(confirmed).toBe(true);expect(seen.size).toBe(1);
    });
    it('Повтор prepare-restore сохраняет выбор и согласие; новый job требует нового согласия',()=>{
        const seen=new Set<string>();let selection=receiveRestorePreview(undefined,plan,'context','recovery');
        const deliver=(id:string,result=structuredClone(plan))=>{
            if(consumeLocalJobResult(seen,{id,state:'succeeded'},'context','context')){
                selection=receiveRestorePreview(selection,result,'context','recovery',selection.paths);
            }
        };
        deliver('first');selection={...selection,confirmed:true};deliver('first');
        expect(restoreSelectionCanApply(selection,'context')).toBe(true);
        deliver('second',{...plan,planId:'33333333-3333-3333-3333-333333333333'});
        expect(restoreSelectionCanApply(selection,'context')).toBe(false);expect(selection.confirmed).toBe(false);
    });
    it('Ожидание, отказ и несовпадающий контекст не разрешают принять результат',()=>{
        const seen=new Set<string>();
        for(const state of ['queued','running','failed'])expect(consumeLocalJobResult(seen,{id:'job',state},'current','current')).toBe(false);
        expect(consumeLocalJobResult(seen,{id:'job',state:'succeeded'},'new-instance','old-instance')).toBe(false);
        expect(consumeLocalJobResult(seen,{id:'job',state:'succeeded'},'current',undefined)).toBe(false);
        expect(seen.size).toBe(0);
    });
    it('Уже принятый job не оживает после другого результата или возврата к прежнему контексту',()=>{
        const seen=new Set<string>();
        expect(consumeLocalJobResult(seen,{id:'a',state:'succeeded'},'context','context')).toBe(true);
        expect(consumeLocalJobResult(seen,{id:'b',state:'succeeded'},'context','context')).toBe(true);
        expect(consumeLocalJobResult(seen,{id:'a',state:'succeeded'},'context','context')).toBe(false);
    });
});
