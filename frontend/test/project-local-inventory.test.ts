import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import type {IBridgeDevice,IBridgeInstallation,IBridgeJob,IInstallPlan} from '../src/features/McpBridge/api';
import type {ILocalChangePlan,ILocalVariants,IProjectInventory} from '../src/features/McpBridge/operationTypes';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import {adoptionCandidateBlocker,approvedAdoptionTarget,inventoryExpired,inventoryMutationBlocker,inventoryScope,localVariantsBlocker,matchingAdoptionPlan,matchingInventory,matchingVariants,projectInventoryBlocker} from '../src/features/McpBridge/inventoryHelpers';
import {latestInstallationReport,localActionBlocker,matchingChangePlan} from '../src/features/McpBridge/operationHelpers';
import {ProjectInventory} from '../src/features/McpBridge/ProjectInventory';
import {LocalInstallations} from '../src/features/McpBridge/LocalInstallations';
import {LocalChangePreview} from '../src/features/McpBridge/LocalChangePreview';

const uuid='11111111-1111-1111-1111-111111111111'; const id2='22222222-2222-2222-2222-222222222222';
const sha='a'.repeat(64); const rootSha='b'.repeat(64); const checkedAt='2026-10-18T00:00:00.000Z';
const device:IBridgeDevice={id:'device',name:'Проверочный компьютер с длинным именем',role:'Наблюдатель',fingerprint:'',online:true,lastSeen:null,report:{
    protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-inventory-v1','adopt-installation-v1','local-recovery-v1'],
    bindings:[{projectId:'project',valid:true,identityStatus:'verified',folderName:'Моя папка',bindingId:sha,instanceId:uuid}],
}};
const row:IBridgeInstallation={deviceId:'device',projectId:'project',assetId:'ai-plug-tool',assetKind:'mcp',version:2,name:'Инструмент',
    manifest:rootSha,bindingId:sha,isCurrentBinding:true,updatedAt:checkedAt};
const inventory:IProjectInventory={schemaVersion:1,projectId:'project',bindingId:sha,instanceId:uuid,scanId:uuid,digest:rootSha,
    checkedAt,expiresAt:'2026-10-18T00:15:00.000Z',complete:true,issues:[],entries:[{candidateId:id2,kind:'mcp',path:'opencode.json',state:'unmanaged',reason:'unmanaged-config'}]};
const variants:ILocalVariants={schemaVersion:1,projectId:'project',bindingId:sha,instanceId:uuid,assetId:row.assetId,assetKind:row.assetKind,
    version:row.version,manifest:row.manifest,checkedAt,complete:true,entries:[{recoveryId:id2,createdAt:checkedAt,files:2,eligible:true,reason:'ready'}]};
const plan:ILocalChangePlan={schemaVersion:1,planId:id2,revision:1,digest:sha,projectId:'project',bindingId:sha,instanceId:uuid,assetId:row.assetId,
    assetKind:'mcp',version:2,manifest:rootSha,checkedAt,expiresAt:inventory.expiresAt,status:'prepared',files:[{path:'.opencode/neurocenter/installations.json',
        operation:'add',beforeSha256:null,afterSha256:rootSha,beforeBytes:0,afterBytes:30,binary:false}]};
const approval:IInstallPlan={id:uuid,projectId:'project',assetId:row.assetId,assetKind:'mcp',version:2,manifest:sha,status:'approved',revision:3,
    approvedBy:'admin@example.test',files:[],config:null,requirements:{},packages:[{kind:'mcp',id:row.assetId,name:row.name,version:2,manifest:rootSha,files:[],config:null,requirements:{}}]};
const job=(kind:string):IBridgeJob=>({id:'job',deviceId:'device',projectId:'project',assetId:row.assetId,assetKind:'mcp',bindingId:sha,
    kind,state:'running',message:'Проверка',createdAt:checkedAt,updatedAt:checkedAt});
function bridge(target=device):ReturnType<typeof useBridge>{return {device:target,devices:[target],devicesReady:true,jobsReady:true,installationsReady:true,
    installations:[row],jobs:[],loading:false,error:'',errors:{devices:'',jobs:'',installations:''},choose:vi.fn(),reload:vi.fn(async()=>{})};}

describe('Поиск только в выбранном экземпляре проекта',()=>{
    it('Наблюдатель может сканировать и видеть варианты, но не принимать и не восстанавливать',()=>{
        expect(projectInventoryBlocker(device,'project',[],true,true,'project-inventory-v1')).toBe('');
        expect(localVariantsBlocker(row,[row],device,[],true,true)).toBe('');
        expect(projectInventoryBlocker(device,'project',[],true,false,'adopt-installation-v1')).toContain('разработчика');
        expect(localActionBlocker(row,[row],device,[],true,false,'local-recovery-v1')).toContain('разработчика');
    });
    it('Отказ подключения, offline, отсутствие capability и неподтверждённая папка блокируют поиск',()=>{
        for(const target of [{...device,online:false},{...device,requiresReconnect:true},{...device,report:{...device.report,capabilities:[]}},
            {...device,report:{...device.report,bindings:[{...device.report.bindings![0],valid:false}]}}]){
            expect(projectInventoryBlocker(target,'project',[],true,true,'project-inventory-v1')).not.toBe('');
        }
        expect(projectInventoryBlocker(device,'other',[],true,true,'project-inventory-v1')).toContain('экземпляр');
        expect(projectInventoryBlocker(device,'project',[],false,true,'project-inventory-v1')).toContain('актуальных');
    });
    it('Активное действие проекта блокирует параллельный просмотр, чужой проект не блокирует',()=>{
        expect(projectInventoryBlocker(device,'project',[job('apply-local-restore')],true,true,'project-inventory-v1')).toContain('завершения');
        expect(projectInventoryBlocker(device,'project',[{...job('apply-local-restore'),projectId:'other'}],true,true,'project-inventory-v1')).toBe('');
    });
    it('Новый heartbeat не меняет контекст; новый device, instance, binding или роль аннулируют контекст',()=>{
        expect(inventoryScope(device,'project')).toBe(inventoryScope({...device,lastSeen:'сейчас'},'project'));
        for(const target of [{...device,id:'other'},{...device,role:'Разработчик'},{...device,report:{...device.report,bindings:[{...device.report.bindings![0],instanceId:id2}]}},
            {...device,report:{...device.report,bindings:[{...device.report.bindings![0],bindingId:rootSha}]}}]){
            expect(inventoryScope(device,'project')).not.toBe(inventoryScope(target,'project'));
        }
    });
    it('Результат другой папки или instance не становится результатом текущего поиска',()=>{
        expect(matchingInventory(inventory,'project',device)).toBe(inventory);
        for(const changes of [{bindingId:rootSha},{instanceId:id2},{projectId:'other'},{scanId:'path/scan'},{digest:'head'}]){
            expect(matchingInventory({...inventory,...changes},'project',device)).toBeUndefined();
        }
    });
    it('Не принимает исходники, содержимое, абсолютный путь, дубликат и более 200 кандидатов',()=>{
        expect(matchingInventory({...inventory,contents:'секрет'},'project',device)).toBeUndefined();
        for(const entry of [{...inventory.entries[0],path:'/Users/private/file'},{...inventory.entries[0],path:'../private'},
            {...inventory.entries[0],content:'секрет'},{...inventory.entries[0],path:'C:\\private'},{...inventory.entries[0],reason:'private source text'}]){
            expect(matchingInventory({...inventory,entries:[entry]},'project',device)).toBeUndefined();
        }
        expect(matchingInventory({...inventory,entries:[inventory.entries[0],inventory.entries[0]]},'project',device)).toBeUndefined();
        expect(matchingInventory({...inventory,entries:Array(201).fill(inventory.entries[0])},'project',device)).toBeUndefined();
    });
    it('Неполнота не выдаётся за полный результат, истёкший preview и часы из будущего распознаются',()=>{
        expect(matchingInventory({...inventory,complete:false,issues:['entry-limit']},'project',device)?.complete).toBe(false);
        expect(inventoryExpired(inventory,Date.parse(inventory.checkedAt))).toBe(false);
        expect(inventoryExpired(inventory,Date.parse(inventory.expiresAt))).toBe(true);
        expect(inventoryExpired(inventory,Date.parse(inventory.checkedAt)-6000)).toBe(true);
    });
    it('Неполный поиск, неканоническое расположение и подмена кандидата не разрешают принятие',()=>{
        const now=Date.parse(checkedAt);
        expect(adoptionCandidateBlocker(inventory,inventory.entries[0],now)).toBe('');
        expect(adoptionCandidateBlocker({...inventory,complete:false},inventory.entries[0],now)).toContain('полный поиск');
        const unknown={...inventory.entries[0],reason:'unknown-layout' as const};
        expect(adoptionCandidateBlocker({...inventory,entries:[unknown]},unknown,now)).toContain('каноническим');
        expect(adoptionCandidateBlocker(inventory,{...inventory.entries[0],path:'another/path'},now)).toContain('нельзя');
    });
    it('Принятие или восстановление после поиска аннулирует старый scan, подготовка не аннулирует',()=>{
        expect(inventoryMutationBlocker(inventory,[job('prepare-adopt-installation')],device.id)).toBe('');
        for(const kind of ['apply-adopt-installation','apply-local-restore','install','uninstall']){
            expect(inventoryMutationBlocker(inventory,[{...job(kind),state:'succeeded'}],device.id)).toContain('изменились');
        }
        expect(inventoryMutationBlocker(inventory,[{...job('install'),deviceId:'other'}],device.id)).toBe('');
    });
});

describe('Явное принятие точной одобренной версии',()=>{
    it('Различает root SHA и SHA всего комплекта, не подставляя head',()=>{
        expect(approvedAdoptionTarget(approval,{assetId:row.assetId,assetKind:'mcp',version:2})).toEqual({manifest:rootSha,approvalManifest:sha});
        for(const changes of [{version:3},{status:'pending' as const},{status:'revoked' as const},{assetId:'other'}]){
            expect(()=>approvedAdoptionTarget({...approval,...changes},{assetId:row.assetId,assetKind:'mcp',version:2})).toThrow();
        }
    });
    it('Preview принятия разрешает только receipts/ledger; запрет скрытой замены пакета и JSONC',()=>{
        expect(matchingAdoptionPlan(plan,row,uuid)).toBe(plan);
        for(const path of ['opencode.json','.opencode/mcp-bundles/tool/index.js','.opencode/neurocenter.json']){
            expect(matchingAdoptionPlan({...plan,files:[{...plan.files[0],path}]},row,uuid)).toBeUndefined();
        }
        expect(matchingAdoptionPlan({...plan,files:[{...plan.files[0],path:'.opencode/neurocenter/receipts/'+'a'.repeat(24)+'.json'}]},row,uuid)).toBeDefined();
    });
    it('План с содержимым или абсолютным путём не попадает в браузерный preview',()=>{
        expect(matchingChangePlan({...plan,rawDiff:'секрет'},row,uuid)).toBeUndefined();
        expect(matchingChangePlan({...plan,files:[{...plan.files[0],before:'секрет'}]},row,uuid)).toBeUndefined();
        expect(matchingChangePlan({...plan,files:[{...plan.files[0],path:'/private/file'}]},row,uuid)).toBeUndefined();
    });
});

describe('Сохранённые локальные варианты',()=>{
    it('Принимает только свой installed tuple и instance',()=>{
        expect(matchingVariants(variants,row,uuid)).toBe(variants);
        for(const changes of [{instanceId:id2},{bindingId:rootSha},{manifest:sha},{version:3},{assetId:'other'}]){
            expect(matchingVariants({...variants,...changes},row,uuid)).toBeUndefined();
        }
        expect(localVariantsBlocker(row,[row],{...device,id:'other'},[],true,true)).toContain('изменилась');
    });
    it('Не принимает сырые backup bytes, лишние поля, больше100 записей и ложную eligibility',()=>{
        for(const value of [{...variants,backup:'секрет'},{...variants,entries:[{...variants.entries[0],contents:'секрет'}]},
            {...variants,entries:Array(101).fill(variants.entries[0])},{...variants,entries:[{...variants.entries[0],eligible:true,reason:'invalid-backup'}]}]){
            expect(matchingVariants(value,row,uuid)).toBeUndefined();
        }
    });
    it('Prepare не обнуляет прежний статус, а apply/restore и adopt аннулируют сверку и runtime',()=>{
        const inspection={schemaVersion:1 as const,projectId:'project',bindingId:sha,assetId:row.assetId,assetKind:row.assetKind,version:2,manifest:rootSha,
            checkedAt,readiness:'unverified' as const,state:'checked' as const,status:'synced' as const,issues:[]};
        const target={...row,inspection};
        expect(latestInstallationReport(target,[job('prepare-local-restore')]).inspection).toBe(inspection);
        for(const kind of ['apply-local-restore','apply-adopt-installation']){
            expect(latestInstallationReport(target,[job(kind)]).inspection).toBeUndefined();
            expect(latestInstallationReport(target,[{...job(kind),state:'succeeded',updatedAt:'2026-10-18T00:01:00.000Z'}]).inspection).toBeUndefined();
        }
    });
});

describe('Общий интерфейс локальных инструментов',()=>{
    it('Две вкладки общие для списка проекта, наблюдатель видит явное действие поиска',()=>{
        const html=renderToStaticMarkup(createElement(LocalInstallations,{bridge:bridge(),projectId:'project',canManage:false,canInspect:true,catalog:[],approved:new Set<string>()}));
        expect(html).toContain('Под управлением'); expect(html).toContain('Найдено в проекте');
        const scan=renderToStaticMarkup(createElement(ProjectInventory,{bridge:bridge(),projectId:'project',canInspect:true,canManage:false,catalog:[]}));
        expect(scan).toContain('Найти инструменты в папке проекта'); expect(scan).toContain('личный глобальный профиль не сканируются');
        expect(scan).not.toContain('Принять под управление');
    });
    it('Длинный относительный путь показан полностью, preview не содержит скрытых исходников',()=>{
        const path='.opencode/skills/'+('длинный-каталог-'.repeat(25))+'/SKILL.md';
        const html=renderToStaticMarkup(createElement(LocalChangePreview,{plan:{...plan,files:[{...plan.files[0],path}]}}));
        expect(html).toContain(path); expect(html).toContain('local-operation__hash'); expect(html).toContain('30 байт');
        expect(html).not.toContain('rawDiff');
    });
});
