import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {bridgeApi, type IBridgeDevice, type IBridgeJob, type IBridgeJobInput} from '../src/features/McpBridge/api';
import {WorkspaceBindingWizard} from '../src/features/McpBridge/WorkspaceBindingWizard';
import type {useBridge} from '../src/features/McpBridge/useBridge';

// Настоящие wizard/useWorkspaceBinding/useLocalJob; только React lifecycle и транспорт управляются тестом.
const hooks=vi.hoisted(()=>{
    let cursor=0;
    const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void;effect?:()=>void|(()=>void)}>=[];
    const effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {
        begin:()=>{cursor=0;},
        commit:()=>{effects.splice(0).forEach(effect=>effect());},
        replay:()=>{slots.forEach(slot=>{if(slot.effect){slot.cleanup?.();slot.cleanup=slot.effect()||undefined;}});},
        dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T|(()=>T)) {
            const slot=slots[cursor++]??={value:typeof initial==='function'?(initial as ()=>T)():initial};
            return [slot.value,(next:T|((previous:T)=>T))=>{slot.value=typeof next==='function'?(next as (previous:T)=>T)(slot.value as T):next;}];
        },
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useMemo<T>(factory:()=>T,dependencies:unknown[]){
            const index=cursor++,previous=slots[index];
            if(!previous||!same(previous.dependencies,dependencies))slots[index]={value:factory(),dependencies};
            return slots[index].value;
        },
        useEffect(effect:()=>void|(()=>void),dependencies?:unknown[]){
            const index=cursor++,previous=slots[index];
            if(previous&&dependencies&&same(previous.dependencies,dependencies))return;
            const slot=slots[index]={dependencies,effect};
            effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});
        },
    };
});
interface Button {children:ReactNode;onClick?:()=>void;disabled?:boolean;loading?:boolean;}
interface Choice {value?:string;disabled?:boolean;onChange:(value:string)=>void;showSearch?:boolean;options?:Array<{value:string;label:string}>;}
const ui=vi.hoisted(()=>({
    scope:'owner-a',epoch:0,buttons:new Map<string,Button>(),choices:new Map<string,Choice>(),close:vi.fn(),
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
    useState:hooks.useState,useRef:hooks.useRef,useMemo:hooks.useMemo,useEffect:hooks.useEffect,
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:ui.scope,
    captureOwner:()=>{const scope=ui.scope,epoch=ui.epoch;return()=>scope===ui.scope&&epoch===ui.epoch;},
})}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{create:vi.fn(),cancel:vi.fn()}}));
vi.mock('antd',async()=>{
    const {createElement:h}=await import('react');
    const content=({children}:{children?:ReactNode})=>children;
    return {Modal:content,Space:content,Collapse:Object.assign(content,{Panel:content}),
        Typography:{Text:content,Paragraph:content},
        Descriptions:Object.assign(content,{Item:({label,children}:{label:string;children:ReactNode})=>h('div',null,label,': ',children)}),
        Alert:({message,description,action}:{message:ReactNode;description?:ReactNode;action?:ReactNode})=>h('div',null,message,description,action),
        Select:(props:Choice&{'aria-label':string})=>{ui.choices.set(props['aria-label'],props);return null;},
        Button:(props:Button)=>{if(typeof props.children==='string')ui.buttons.set(props.children,props);return h('button',{disabled:props.disabled},props.children);},
    };
});

function deferred<T>() {
    let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;
    const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
    return {promise,resolve,reject};
}
function fixture() {
    const device:IBridgeDevice={id:'computer-a',name:'Компьютер А',role:'Разработчик',fingerprint:'',online:true,lastSeen:null,
        report:{root:'/fixture/projects',folders:['Папка А','Папка Б'],protocolVersion:2,
            capabilities:['durable-completions','managed-installations','workspace-instance-v1'],
            bindings:[{projectId:'project-a',folderName:'Папка А',valid:true,identityStatus:'verified',
                bindingId:'a'.repeat(64),instanceId:'11111111-1111-1111-1111-111111111111'}]}};
    return {device,devices:[device],jobs:[] as IBridgeJob[],installations:[],devicesReady:true,jobsReady:true,
        installationsReady:true,loading:false,errors:{devices:'',jobs:'',installations:''},error:'',choose:vi.fn(),reload:vi.fn().mockResolvedValue(undefined)};
}
let bridge:ReturnType<typeof fixture>,project:{id:string;name:string},canManage:boolean,nextId:number;
function render() {
    hooks.begin();ui.buttons.clear();ui.choices.clear();
    const html=renderToStaticMarkup(createElement(WorkspaceBindingWizard,{bridge:bridge as ReturnType<typeof useBridge>,project,canManage,onClose:ui.close}));
    hooks.commit();return html;
}
function button(label:string) {const item=ui.buttons.get(label);expect(item,`кнопка ${label}`).toBeDefined();return item!;}
function folder(){return ui.choices.get('Локальная папка проекта')!;}
function mode(){return ui.choices.get('Действие с папкой')!;}
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();render();render();}
function accepted(input:IBridgeJobInput):IBridgeJob {
    const job:IBridgeJob={id:`job-${++nextId}`,deviceId:input.deviceId,projectId:input.projectId||null,kind:input.kind,
        state:'queued',message:'Ожидает мост',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    bridge.jobs.push(job);return job;
}
function complete(index=0,patch:Record<string,unknown>={}) {
    const input=vi.mocked(bridgeApi.create).mock.calls[index][0];
    if(input.kind!=='prepare-bind-project')throw new Error('Ожидалась проверка папки');
    bridge.jobs=bridge.jobs.map(job=>job.id===`job-${index+1}`?{...job,state:'succeeded',message:'Папка проверена',result:{
        projectId:input.projectId,folderName:input.folderName,mode:input.bindingMode,preparation:'b'.repeat(64),
        expectedBindingId:input.expectedBindingId,expectedInstanceId:input.expectedInstanceId,requiresFileVerification:input.bindingMode!=='new',...patch,
    }}:job);render();render();
}
async function prepareSelected() {render();folder().onChange('Папка Б');await settle();complete();}
function switchScope(scope:string){ui.scope=scope;ui.epoch++;render();render();}

beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));vi.clearAllMocks();
    bridge=fixture();project={id:'project-a',name:'Проект А'};canManage=true;nextId=0;ui.scope='owner-a';ui.epoch=0;
    vi.mocked(bridgeApi.create).mockImplementation(async input=>accepted(input));vi.mocked(bridgeApi.cancel).mockResolvedValue(undefined);
});
afterEach(()=>{hooks.dispose();vi.restoreAllMocks();vi.useRealTimers();});

describe('Обычная привязка папки: явный выбор и конкретное подтверждение',()=>{
    it('Предзаполнение, StrictMode, heartbeat и восстановление связи не создают задания',()=>{
        render();expect(folder().value).toBe('Папка А');expect(folder().showSearch).toBe(true);
        hooks.replay();render();bridge.device.lastSeen=new Date().toISOString();render();
        bridge.device.online=false;render();bridge.device.online=true;render();
        bridge.device.requiresReconnect=true;render();bridge.device.requiresReconnect=false;render();
        expect(bridgeApi.create).not.toHaveBeenCalled();expect(button('Проверить папку').disabled).toBe(false);
    });
    it('Один явный выбор проверяет именно новую папку, финальная кнопка создаёт одну привязку',async()=>{
        await prepareSelected();
        expect(bridgeApi.create).toHaveBeenCalledOnce();expect(vi.mocked(bridgeApi.create).mock.calls[0][0]).toMatchObject({
            kind:'prepare-bind-project',folderName:'Папка Б',bindingMode:'new',deviceId:'computer-a',projectId:'project-a'});
        const html=render();expect(html.match(/\/fixture\/projects/g)).toHaveLength(1);expect(html.match(/Компьютер:/g)).toHaveLength(1);
        expect(folder().value).toBe('Папка Б');expect(html).toContain('Папка и экземпляр проверены');expect(html).not.toContain('Папка проверена');
        expect(button('Связать папку').disabled).toBe(false);
        button('Связать папку').onClick!();button('Связать папку').onClick!();await settle();
        expect(bridgeApi.create).toHaveBeenCalledTimes(2);expect(vi.mocked(bridgeApi.create).mock.calls[1][0]).toMatchObject({
            kind:'bind-project',folderName:'Папка Б',preparationJobId:'job-1',expectedPreparation:'b'.repeat(64)});
        expect(render()).toContain('Ожидает мост');
        expect(ui.close).not.toHaveBeenCalled();bridge.jobs[1]={...bridge.jobs[1],state:'succeeded'};render();render();
        expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Два быстрых выбора до render сохраняют первый запрос и не перезаписывают папку',async()=>{
        const response=deferred<IBridgeJob>();vi.mocked(bridgeApi.create).mockReturnValueOnce(response.promise);
        render();const choose=folder().onChange;choose('Папка Б');choose('Папка А');
        expect(bridgeApi.create).toHaveBeenCalledOnce();render();expect(folder().value).toBe('Папка Б');expect(folder().disabled).toBe(true);
        response.resolve(accepted(vi.mocked(bridgeApi.create).mock.calls[0][0]));await settle();complete();
        expect(button('Связать папку').disabled).toBe(false);
    });
    it('Все цитируемые сервером действия присутствуют в Select, финальная кнопка остаётся конкретной',async()=>{
        render();const options=new Map(mode().options?.map(option=>[option.value,option.label]));
        // workspace-failure.ts: legacy-binding, copied-folder и resume-required.
        expect(options.get('adopt-legacy')).toBe('Подтвердить старую привязку');
        expect(options.get('new-copy')).toBe('Создать отдельную копию');
        expect(options.get('transfer')).toBe('Перенести существующий экземпляр');
        expect(options.get('resume')).toBe('Ранее подключённая папка');
        mode().onChange('resume');await settle();complete();expect(button('Вернуться к папке').disabled).toBe(false);
    });
    it.each(['new-copy','transfer','adopt-legacy','resume'])('Действие %s сохраняет исходные условия и проверяет файлы при подтверждении',async selected=>{
        if(selected==='adopt-legacy')bridge.device.report.bindings![0]={...bridge.device.report.bindings![0],valid:false,identityStatus:'legacy',previousBindingId:'c'.repeat(64)};
        render();mode().onChange(selected);await settle();complete();
        const request=vi.mocked(bridgeApi.create).mock.calls[0][0];expect(request).toMatchObject({kind:'prepare-bind-project',bindingMode:selected,folderName:'Папка А'});
        if(selected==='adopt-legacy')expect(request).toHaveProperty('expectedBindingId','c'.repeat(64));
        if(selected==='new-copy'||selected==='transfer')expect(request).toMatchObject({expectedBindingId:'a'.repeat(64),expectedInstanceId:'11111111-1111-1111-1111-111111111111'});
        const html=render();expect(html).toContain('До этого они не считаются проверенными');expect(html).toContain('Эти действия не копируют и не перемещают файлы');
        if(selected!=='resume')expect(html).toContain('Прежняя папка: <strong>Папка А</strong>');
        const label=selected==='new-copy'?'Связать как отдельную копию':selected==='transfer'?'Подтвердить перенос':selected==='resume'?'Вернуться к папке':'Подтвердить старую привязку';
        expect(button(label).disabled).toBe(false);expect(bridgeApi.create).toHaveBeenCalledOnce();
    });
    it.each([{folderName:'Чужая папка'},{mode:'transfer'},{preparation:'invalid'}])('Неверный результат %j не открывает подтверждение',async patch=>{
        render();folder().onChange('Папка Б');await settle();complete(0,patch);
        expect(ui.buttons.has('Связать папку')).toBe(false);expect(render()).toContain('Ответ моста не соответствует выбранной папке');
    });
    it('Смена root или исходной привязки и истечение 15 минут требуют новой проверки',async()=>{
        await prepareSelected();bridge.device.report.root='/fixture/new-root';
        expect(render()).toContain('Компьютер или исходная привязка изменились');expect(ui.buttons.has('Связать папку')).toBe(false);
        bridge.device.report.root='/fixture/projects';render();expect(button('Связать папку').disabled).toBe(false);
        vi.advanceTimersByTime(15*60000);expect(render()).toContain('Проверка папки устарела');expect(ui.buttons.has('Связать папку')).toBe(false);
        expect(button('Повторить проверку').disabled).toBe(false);
    });
    it('Пустой список и невыбранная общая папка дают конкретный следующий шаг без задания',async()=>{
        bridge.device.report.folders=[];expect(render()).toContain('Создайте подпапку проекта');
        button('Обновить список').onClick!();await settle();expect(bridge.reload).toHaveBeenCalledOnce();expect(bridgeApi.create).not.toHaveBeenCalled();
        bridge.device.report.root=null;expect(render()).toContain('Закройте это окно');button('К выбору общей папки').onClick!();expect(ui.close).toHaveBeenCalledOnce();
    });
});

describe('Неопределённый ответ и поздние результаты привязки',()=>{
    it('Окончательный 409 не запирает выбор: новая проверка использует обновлённую привязку и новый ключ',async()=>{
        vi.mocked(bridgeApi.create).mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Исходная привязка изменилась'}}});
        render();mode().onChange('transfer');await settle();
        expect(folder().disabled).toBe(false);expect(mode().disabled).toBe(false);expect(ui.buttons.has('Повторить отправленный запрос')).toBe(false);
        bridge.device.report.bindings![0]={...bridge.device.report.bindings![0],bindingId:'c'.repeat(64)};render();
        expect(render()).toContain('Компьютер или исходная привязка изменились');folder().onChange('Папка Б');await settle();
        const calls=vi.mocked(bridgeApi.create).mock.calls;expect(calls).toHaveLength(2);
        expect(calls[1][0]).toMatchObject({folderName:'Папка Б',bindingMode:'transfer',expectedBindingId:'c'.repeat(64)});
        expect(calls[1][0].requestKey).not.toBe(calls[0][0].requestKey);
    });
    it('Lost ACK и orphan prepare из poll позволяют повтор исходного ключа без adopt по имени',async()=>{
        let original!:IBridgeJob;
        vi.mocked(bridgeApi.create).mockImplementationOnce(async input=>{original=accepted(input);throw new Error('Ответ потерян');});
        render();folder().onChange('Папка Б');await settle();
        expect(button('Повторить отправленный запрос')).toMatchObject({disabled:false,loading:false});expect(folder().disabled).toBe(true);
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(original);button('Повторить отправленный запрос').onClick!();await settle();
        const calls=vi.mocked(bridgeApi.create).mock.calls;expect(calls[1][0]).toEqual(calls[0][0]);expect(bridge.jobs).toHaveLength(1);
        complete();expect(button('Связать папку').disabled).toBe(false);expect(ui.close).not.toHaveBeenCalled();
    });
    it.each(['bind-project','choose-root'])('Lost ACK не обходит другое действие %s',async kind=>{
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Ответ потерян'));render();folder().onChange('Папка Б');await settle();
        bridge.jobs.push({...accepted(vi.mocked(bridgeApi.create).mock.calls[0][0]),id:'foreign',kind});render();
        expect(button('Повторить отправленный запрос').disabled).toBe(true);expect(bridgeApi.create).toHaveBeenCalledOnce();
    });
    it('Отказ UUID освобождает выбор и кнопку, следующий явный запрос работает',async()=>{
        vi.spyOn(crypto,'randomUUID').mockImplementationOnce(()=>{throw new Error('UUID unavailable');});
        render();folder().onChange('Папка Б');await settle();expect(bridgeApi.create).not.toHaveBeenCalled();expect(folder().disabled).toBe(false);
        expect(render()).toContain('Не удалось подготовить запрос к мосту');button('Повторить проверку').onClick!();await settle();expect(bridgeApi.create).toHaveBeenCalledOnce();
    });
    it('Lost ACK commit ждёт мутацию и затем возвращает исходный результат, даже если preview устарел',async()=>{
        await prepareSelected();let committed!:IBridgeJob;
        vi.mocked(bridgeApi.create).mockImplementationOnce(async input=>{committed=accepted(input);throw new Error('Ответ привязки потерян');});
        button('Связать папку').onClick!();await settle();expect(button('Проверить отправленную привязку').disabled).toBe(true);
        bridge.jobs[1]={...committed,state:'succeeded'};bridge.device.report.root='/fixture/changed';vi.advanceTimersByTime(16*60000);render();
        expect(button('Проверить отправленную привязку').disabled).toBe(false);vi.mocked(bridgeApi.create).mockResolvedValueOnce(bridge.jobs[1]);
        button('Проверить отправленную привязку').onClick!();await settle();
        const calls=vi.mocked(bridgeApi.create).mock.calls;expect(calls[2][0]).toEqual(calls[1][0]);expect(ui.close).toHaveBeenCalledOnce();expect(bridge.jobs).toHaveLength(2);
    });
    it('Принятый commit→lost ACK→403→восстановление прав сохраняет исходный ключ',async()=>{
        await prepareSelected();let committed!:IBridgeJob;
        vi.mocked(bridgeApi.create).mockImplementationOnce(async input=>{committed=accepted(input);throw new Error('Ответ потерян');});
        button('Связать папку').onClick!();await settle();bridge.jobs[1]={...committed,state:'succeeded'};render();
        vi.mocked(bridgeApi.create).mockRejectedValueOnce({isAxiosError:true,response:{status:403,data:{message:'Права временно отозваны'}}});
        button('Проверить отправленную привязку').onClick!();await settle();
        expect(button('Проверить отправленную привязку').disabled).toBe(false);expect(ui.close).not.toHaveBeenCalled();
        vi.mocked(bridgeApi.create).mockResolvedValueOnce(bridge.jobs[1]);button('Проверить отправленную привязку').onClick!();await settle();
        const calls=vi.mocked(bridgeApi.create).mock.calls;expect(calls[3][0]).toEqual(calls[2][0]);expect(calls[2][0]).toEqual(calls[1][0]);
        expect(ui.close).toHaveBeenCalledOnce();expect(bridge.jobs).toHaveLength(2);
    });
    it.each(['владелец','проект','компьютер'])('Поздний prepare после смены %s A→B→A не возвращает старый preview',async change=>{
        const response=deferred<IBridgeJob>();vi.mocked(bridgeApi.create).mockReturnValueOnce(response.promise);
        render();folder().onChange('Папка Б');
        if(change==='владелец'){switchScope('owner-b');switchScope('owner-a');}
        else if(change==='проект'){project={id:'project-b',name:'Проект Б'};render();project={id:'project-a',name:'Проект А'};render();}
        else {bridge.device={...bridge.device,id:'computer-b'};render();bridge.device={...bridge.device,id:'computer-a'};render();}
        const completed={...accepted(vi.mocked(bridgeApi.create).mock.calls[0][0]),state:'succeeded'};bridge.jobs=[completed];response.resolve(completed);await settle();
        expect(ui.buttons.has('Связать папку')).toBe(false);expect(button('Проверить папку').disabled).toBe(false);expect(ui.close).not.toHaveBeenCalled();
    });
    it('Отозванная роль перед ответом commit не закрывает окно нового владельца',async()=>{
        await prepareSelected();const response=deferred<IBridgeJob>();vi.mocked(bridgeApi.create).mockReturnValueOnce(response.promise);
        button('Связать папку').onClick!();canManage=false;switchScope('observer');
        response.resolve({...accepted(vi.mocked(bridgeApi.create).mock.calls[1][0]),state:'succeeded'});await settle();
        expect(ui.close).not.toHaveBeenCalled();expect(button('Проверить папку').disabled).toBe(true);
    });
    it('Unmount перед ответом commit не закрывает следующую форму',async()=>{
        await prepareSelected();const response=deferred<IBridgeJob>();vi.mocked(bridgeApi.create).mockReturnValueOnce(response.promise);
        button('Связать папку').onClick!();hooks.dispose();
        response.resolve({...accepted(vi.mocked(bridgeApi.create).mock.calls[1][0]),state:'succeeded'});await Promise.resolve();await Promise.resolve();
        render();expect(ui.close).not.toHaveBeenCalled();expect(ui.buttons.has('Связать папку')).toBe(false);
    });
    it('Queued отменяется один раз; поздний отказ после смены владельца не появляется в новой форме',async()=>{
        render();folder().onChange('Папка Б');await settle();const response=deferred<void>();vi.mocked(bridgeApi.cancel).mockReturnValueOnce(response.promise);
        const cancel=button('Отменить').onClick!;cancel();cancel();expect(bridgeApi.cancel).toHaveBeenCalledOnce();
        switchScope('owner-b');response.reject(new Error('Поздняя отмена'));await settle();expect(render()).not.toContain('Не удалось отменить задание');
        expect(bridge.reload).toHaveBeenCalledOnce();
    });
    it('Running задание не предлагает отмену',async()=>{
        render();folder().onChange('Папка Б');await settle();bridge.jobs[0]={...bridge.jobs[0],state:'running'};render();
        expect(ui.buttons.has('Отменить')).toBe(false);expect(bridgeApi.cancel).not.toHaveBeenCalled();
    });
});
