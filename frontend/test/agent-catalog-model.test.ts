import { describe, expect, it } from 'vitest';
import { agentConnection, agentModelPattern, agentOverrides, promptBytes, projectAgentStatus, requireAgentCatalog, selectedAgentTarget, validAgentText, visibleAgents } from '../src/features/AgentCatalog/model';
import { normalizedAgentDefinition } from '../src/features/AgentCatalog/AgentDefinitionFields';
import { createAgentRequestKeys } from '../src/features/AgentCatalog/requestKeys';
import { catalogSection, catalogSectionUrl } from '../src/modules/Store/catalogSection';
import { agent, assignment, bridge, catalog, delivery, target } from './agent-fixtures';

describe('Агенты: immutable pins и безопасное чтение каталога', () => {
    it('Принимает пустой проект revision=0 и отдельный общий каталог', () => {
        expect(requireAgentCatalog(catalog())).toMatchObject({revision:3});
        expect(requireAgentCatalog(catalog({assignments:[],revision:0}))).toMatchObject({revision:0});
        expect(requireAgentCatalog(catalog({assignments:[],revision:null}))).toMatchObject({revision:null});
    });
    it.each(['items','assignments','revision','deliveries'])('Не превращает отсутствующее поле %s в пустой успешный каталог', field => {
        const value: Record<string, unknown> = {...catalog()}; delete value[field]; expect(() => requireAgentCatalog(value)).toThrow('неполный');
    });
    it.each([
        catalog({items:[agent(),agent()]}),catalog({assignments:[assignment(),assignment()]}),catalog({assignments:[assignment({version:2})]}),
        catalog({assignments:[assignment({manifest:'e'.repeat(64)})]}),catalog({assignments:[assignment({enabled:true,removed:true})]}),
        catalog({items:[agent({definition:{...agent().definition,permission:{unknown:'allow'}}})]}),
        catalog({items:[agent({definition:{...agent().definition,prompt:'a\0b'}})]}),
        catalog({items:[agent({definition:{...agent().definition,temperature:2.1}})]}),catalog({items:[agent({definition:{...agent().definition,topP:-0.1}})]}),
        catalog({items:[agent({definition:{...agent().definition,steps:1001}})]}),catalog({items:[agent({slug:'build'})]}),
    ])('Отклоняет повреждённый ответ %#', value => { expect(() => requireAgentCatalog(value)).toThrow('неполный'); });
    it('Считает UTF8 байты описания/промпта и не обрезает Markdown', () => {
        expect(promptBytes('я')).toBe(2); expect(promptBytes('🤖')).toBe(4);
        const long = 'я'.repeat(513); expect(() => requireAgentCatalog(catalog({items:[agent({description:long,definition:{...agent().definition,description:long}})]}))).toThrow();
        expect(() => requireAgentCatalog(catalog({items:[agent({definition:{...agent().definition,prompt:'🤖'.repeat(16385)}})]}))).toThrow();
        const input = { ...agent().definition, prompt:'  # Инструкция\n\n  отступ  ', model:'', temperature:null as unknown as number };
        expect(normalizedAgentDefinition(input)).toEqual(agent().definition && {...agent().definition,prompt:input.prompt});
    });
    it('Согласован с native validator по Unicode, управляющим символам и model URI',()=>{
        expect(validAgentText('Строка\nвторая')).toBe(false);expect(validAgentText('Строка\n\tвторая',true)).toBe(true);
        expect(validAgentText('Не парный \ud800',true)).toBe(false);expect(validAgentText('Escape\x1b',true)).toBe(false);expect(agentModelPattern.test('provider/model://secret')).toBe(false);
    });
    it('Фильтр проекта исключает удалённые назначения и сохраняет недоступный pin', () => {
        const pin = agent({id:'agent-gone',name:'Архивный',slug:'nc-old'});
        const data = catalog({assignments:[assignment(),assignment({agentId:pin.id,card:pin}),assignment({agentId:'removed',card:agent({id:'removed'}),removed:true})]});
        expect(visibleAgents(data,'',true).map(value=>value.id)).toEqual(['agent-review','agent-gone']);
        expect(visibleAgents(data,' РЕВЬЮЕР ',false).map(value=>value.id)).toContain('agent-review');
        expect(visibleAgents(data,'Архивный',true)).toEqual([pin]);
    });
    it('Поиск находит закреплённое имя после переименования общей карточки',()=>{
        expect(visibleAgents(catalog({items:[agent({name:'Новое имя'})],assignments:[assignment({card:agent({name:'Прежнее имя'})})]}),'Прежнее',true)).toHaveLength(1);
    });
    it('Умеет снять model/параметр и сбросить override к точному шаблону', () => {
        const base = {...agent().definition,model:'provider/old',temperature:0.7};
        expect(agentOverrides(base,{...agent().definition})).toEqual({model:null,temperature:null});
        expect(agentOverrides(base,{...base,permission:{edit:'ask',read:'allow'}})).toEqual({});
        expect(agentOverrides(base,{...base,prompt:'Другой промпт'})).toEqual({prompt:'Другой промпт'});
    });
    it.each(['https://host/model','model','provider/model --token secret','../model','provider/'])('Отклоняет URL/неполную модель %s', value=>expect(agentModelPattern.test(value)).toBe(false));
});

describe('Подтверждение OpenCode относится к exact target, revision и snapshot', () => {
    it('Desired enabled=true до ACK не становится установленным', () => {
        const desired=assignment({enabled:true}); expect(projectAgentStatus(catalog({assignments:[desired]}),desired,target).key).toBe('unapplied');
    });
    it('Только валидная configured квитанция подтверждает отключённую настройку', () => {
        expect(projectAgentStatus(catalog({deliveries:[delivery()]}),assignment(),target)).toMatchObject({key:'disabled',label:'Отключён в настройках'});
        const desired=assignment({enabled:true}); const result={...delivery().result!,agents:[{id:agent().id,slug:agent().slug,version:1,enabled:true,sha256:'d'.repeat(64)}]};
        expect(projectAgentStatus(catalog({assignments:[desired],deliveries:[delivery({result})]}),desired,target)).toMatchObject({key:'enabled',label:'Настроен в OpenCode'});
    });
    it.each([
        {revision:2},{bindingId:'other'},{instanceId:'other'},{deviceId:'other'}, {state:'succeeded',result:null},
        {result:{...delivery().result!,readiness:'running'}},{result:{...delivery().result!,manifestSha256:'e'.repeat(64)}},
        {result:{...delivery().result!,agents:[]}},{result:{...delivery().result!,agents:[{id:'other'}]}},
    ])('Не подтверждает устаревшую/чужую квитанцию %#', changes=>{
        expect(projectAgentStatus(catalog({deliveries:[delivery(changes)]}),assignment(),target).key).toBe('unapplied');
    });
    it('Различает очередь, конфликт и ожидание физического удаления', () => {
        expect(projectAgentStatus(catalog({deliveries:[delivery({state:'queued',result:null})]}),assignment(),target).key).toBe('pending');
        expect(projectAgentStatus(catalog({deliveries:[delivery({state:'failed',message:'Локальные правки'})]}),assignment(),target)).toMatchObject({key:'error',detail:'Локальные правки'});
        const removed=assignment({removed:true}); const data=catalog({assignments:[removed]});
        expect(projectAgentStatus(data,removed,target).label).toBe('Ожидает удаления из OpenCode');
        data.deliveries=[delivery({result:{...delivery().result!,agents:[]}})]; expect(projectAgentStatus(data,removed,target).key).toBe('removed');
    });
    it('Не использует успех другого компьютера и позволяет очередь offline', () => {
        const props={projectId:'project-one',bridge:bridge()}; props.bridge.device!.online=false;
        expect(agentConnection(props).target).toEqual(target);
        props.bridge.device!.role='Наблюдатель'; expect(agentConnection(props).target).toBeUndefined(); expect(selectedAgentTarget(props)).toEqual(target);
        props.bridge.devicesReady=false; expect(selectedAgentTarget(props)).toBeUndefined();
    });
    it('Роль Developer bridge не разрешает агентные изменения, project-admin разрешает',()=>{
        const props={projectId:'project-one',bridge:bridge()};props.bridge.device!.role='Разработчик';expect(agentConnection(props)).toEqual({reason:'Подключите мост с ролью администратора для настройки агентов.'});
        props.bridge.device!.role='Админ проекта';expect(agentConnection(props).target).toEqual(target);
    });
    it.each(['native','binding','jobs','expired'])('Блокирует доставку при %s', reason=>{
        const props={projectId:'project-one',bridge:bridge()};
        if(reason==='native')props.bridge.device!.report.capabilities=[];
        if(reason==='binding')props.bridge.device!.report.bindings=[];
        if(reason==='jobs')props.bridge.jobsReady=false;
        if(reason==='expired')props.bridge.device!.requiresReconnect=true;
        expect(agentConnection(props).target).toBeUndefined(); expect(agentConnection(props).reason).toBeTruthy();
    });
});

it('Повтор потерянного ACK сохраняет ключ и CAS; новое намерение/owner получают новый ключ', () => {
    let n=0;const keys=createAgentRequestKeys(()=>String(++n));const body={revision:3,agentId:'agent-one'};
    expect(keys.forRequest('save',body)).toBe(keys.forRequest('save',body)); expect(keys.forRequest('save',{...body,revision:4})).toBe('2');
    expect(keys.forRequest('remove',body)).toBe('3');keys.clear();expect(keys.forRequest('save',body)).toBe('4');
});
it('Прямые ссылки агентов сохраняют вкладку проекта, поиск и якорь', () => {
    expect(catalogSection('?tab=agents')).toBe('agents'); expect(catalogSection('?tab=store&catalogTab=agents',true)).toBe('agents');
    expect(catalogSectionUrl('/projects/a','?tab=store&q=one','agents',true,'#catalog')).toBe('/projects/a?tab=store&q=one&catalogTab=agents#catalog');
});
