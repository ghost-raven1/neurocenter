import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentActions } from '../src/features/AgentCatalog/useAgentActions';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import type { IAgentCatalogProps, TAgentJob } from '../src/features/AgentCatalog/types';
import { agent, assignment, bridge, catalog, delivery, target } from './agent-fixtures';

const hooks=vi.hoisted(()=>{
    let cursor=0; const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[];const effects:Array<()=>void>=[];
    return {
        begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:typeof initial==='function'?initial():initial};return[slot.value,(value:unknown)=>{slot.value=typeof value==='function'?value(slot.value):value;}];},
        useRef:(initial:unknown)=>(slots[cursor++]??={value:{current:initial}}).value,
        useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous?.deps?.length===deps.length&&deps.every((v,i)=>Object.is(v,previous.deps![i])))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const ui=vi.hoisted(()=>({owner:'admin'}));
vi.mock('react',()=>hooks);
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;return {scope:owner,captureOwner:()=>()=>ui.owner===owner};}}));
vi.mock('../src/features/AgentCatalog/api',()=>({agentCatalogApi:{assign:vi.fn(),configure:vi.fn(),remove:vi.fn(),connect:vi.fn()}}));
const refresh=vi.fn(),reload=vi.fn();
let props:IAgentCatalogProps & {catalog:ReturnType<typeof catalog>;refresh:typeof refresh};
function render(){hooks.begin();const result=useAgentActions(props);hooks.commit();return result;}
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const saved={revision:4,assignment:assignment()};
const job={id:'job-new',deviceId:target.deviceId,projectId:'project-one',kind:'configure-project-agents',desiredRevision:4,state:'queued',message:'В очереди'} as TAgentJob;
beforeEach(()=>{
    vi.clearAllMocks();ui.owner='admin';props={projectId:'project-one',canManage:true,isMain:true,bridge:bridge(),catalog:catalog(),refresh};props.bridge.reload=reload;
    refresh.mockImplementation(async()=>props.catalog);reload.mockResolvedValue(undefined);
    for(const call of[agentCatalogApi.assign,agentCatalogApi.configure,agentCatalogApi.remove])vi.mocked(call).mockResolvedValue(saved);
    vi.mocked(agentCatalogApi.connect).mockResolvedValue(job);
});
afterEach(()=>hooks.dispose());

describe('Агент сохраняется и применяется одной командой пользователя',()=>{
    it('Ждёт desired save, блокирует двойной клик и передаёт новую revision мосту',async()=>{
        const pending=deferred<typeof saved>();vi.mocked(agentCatalogApi.assign).mockReturnValue(pending.promise);const actions=render();
        const first=actions.mutate({kind:'assign',agent:agent(),revision:3});await actions.mutate({kind:'assign',agent:agent(),revision:3});
        expect(agentCatalogApi.assign).toHaveBeenCalledOnce();expect(agentCatalogApi.connect).not.toHaveBeenCalled();expect(render().busy).toBe(true);
        pending.resolve(saved);await first;expect(agentCatalogApi.connect).toHaveBeenCalledExactlyOnceWith('project-one',target,4,expect.any(String));
        expect(render()).toMatchObject({busy:false,error:'',unconfirmed:false});expect(render().notice).toContain('подтверждение записи');
    });
    it.each(['role','project'])('Прямой callback не обходит guard %s',async guard=>{
        if(guard==='role')props.canManage=false;else props.projectId=undefined;
        await render().mutate({kind:'assign',agent:agent(),revision:3});expect(agentCatalogApi.assign).not.toHaveBeenCalled();expect(agentCatalogApi.connect).not.toHaveBeenCalled();
    });
    it('Без binding сохраняет desired, не выдумывает установку',async()=>{
        props.bridge.device!.report.bindings=[];await render().mutate({kind:'configure',agent:agent(),revision:3,patch:{enabled:true}});
        expect(agentCatalogApi.configure).toHaveBeenCalledOnce();expect(agentCatalogApi.connect).not.toHaveBeenCalled();expect(render().notice).toContain('Настройки сохранены в проекте');
    });
    it('Пустой untouched revision=0 не отправляет connect; пустой snapshot после remove разрешает cleanup',async()=>{
        props.catalog=catalog({revision:0,assignments:[]});await render().apply();expect(agentCatalogApi.connect).not.toHaveBeenCalled();
        props.catalog=catalog({revision:4,assignments:[assignment({removed:true})]});await render().apply();expect(agentCatalogApi.connect).toHaveBeenCalledOnce();
    });
    it('Offline с валидным binding получает честный queued статус',async()=>{
        props.bridge.device!.online=false;await render().mutate({kind:'remove',agent:agent(),revision:3});expect(agentCatalogApi.connect).toHaveBeenCalledOnce();expect(render().notice).toContain('когда компьютер выйдет на связь');
    });
    it('Ошибка доставки после успешного save не выдаётся за ошибку сохранения промпта',async()=>{
        vi.mocked(agentCatalogApi.connect).mockRejectedValue(new Error('Мост недоступен'));
        await expect(render().mutate({kind:'configure',agent:agent(),revision:3,patch:{overrides:{prompt:'Мой текст'}}})).resolves.toEqual(saved);
        expect(render()).toMatchObject({unconfirmed:false,busy:false});expect(render().error).toContain('Настройки сохранены в проекте');
    });
    it('Чужой job/revision не выдаются за принятую доставку',async()=>{
        vi.mocked(agentCatalogApi.connect).mockResolvedValue({...job,deviceId:'another',desiredRevision:3});
        await render().mutate({kind:'assign',agent:agent(),revision:3});expect(render().notice).not.toContain('переданы мосту');expect(render().error).toContain('не подтвердил приём');
    });
    it('Terminal failed ответ повторного job не выдаётся за ожидание успешного ACK',async()=>{
        vi.mocked(agentCatalogApi.connect).mockResolvedValue({...job,state:'failed',message:'Файл изменён локально'});await render().mutate({kind:'assign',agent:agent(),revision:3});
        expect(render().notice).toBe('');expect(render().error).toContain('Файл изменён локально');expect(refresh).toHaveBeenCalledTimes(2);
    });
    it('CAS conflict перечитывает проект, не вызывает мост и не теряет исходный payload',async()=>{
        const conflict={response:{status:409,data:{message:'Настройки изменились'}}};vi.mocked(agentCatalogApi.configure).mockRejectedValue(conflict);
        await expect(render().mutate({kind:'configure',agent:agent(),revision:3,patch:{overrides:{prompt:'Draft'}}})).rejects.toBe(conflict);
        expect(refresh).toHaveBeenCalledOnce();expect(agentCatalogApi.connect).not.toHaveBeenCalled();expect(render().unconfirmed).toBe(false);
        expect(agentCatalogApi.configure).toHaveBeenCalledWith('project-one',agent().id,{overrides:{prompt:'Draft'}},3,expect.any(String));
    });
    it('Lost ACK повторяет точный requestKey и прежнюю CAS revision',async()=>{
        vi.mocked(agentCatalogApi.remove).mockRejectedValueOnce(new Error('Ответ потерян'));
        await expect(render().mutate({kind:'remove',agent:agent(),revision:3})).rejects.toThrow();const first=vi.mocked(agentCatalogApi.remove).mock.calls[0];
        props.catalog=catalog({revision:4});expect(render().unconfirmed).toBe(true);await render().repeat();
        expect(vi.mocked(agentCatalogApi.remove).mock.calls[1]).toEqual(first);expect(render().unconfirmed).toBe(false);
    });
    it('Повтор применения после failed delivery создаёт новый intent, lost ACK того же intent сохраняет ключ',async()=>{
        props.catalog=catalog({revision:4,deliveries:[]});vi.mocked(agentCatalogApi.connect).mockRejectedValue(new Error('Потерян ответ'));
        await render().apply();await render().apply();const first=vi.mocked(agentCatalogApi.connect).mock.calls[0][3];expect(vi.mocked(agentCatalogApi.connect).mock.calls[1][3]).toBe(first);
        props.catalog=catalog({revision:4,deliveries:[delivery({jobId:'failed-old',revision:4,state:'failed',result:null})]});await render().apply();expect(vi.mocked(agentCatalogApi.connect).mock.calls[2][3]).not.toBe(first);
    });
});

describe('Late responses не меняют другой проект или компьютер',()=>{
    it('Смена target во время save требует отдельного Apply и не отправляет неожиданно новому компьютеру',async()=>{
        const pending=deferred<typeof saved>();vi.mocked(agentCatalogApi.assign).mockReturnValue(pending.promise);const save=render().mutate({kind:'assign',agent:agent(),revision:3});
        props={...props,bridge:{...props.bridge,device:{...props.bridge.device!,id:'device-other'}}};render();pending.resolve(saved);await save;
        expect(agentCatalogApi.connect).not.toHaveBeenCalled();expect(render().notice).toContain('компьютер или папка изменились');
    });
    it.each(['scope','project'])('Поздний результат прежнего %s игнорируется',async change=>{
        const pending=deferred<typeof saved>();vi.mocked(agentCatalogApi.assign).mockReturnValue(pending.promise);const save=render().mutate({kind:'assign',agent:agent(),revision:3});
        if(change==='scope')ui.owner='admin-new';else props={...props,projectId:'project-two'};render();pending.resolve(saved);await save;
        expect(refresh).not.toHaveBeenCalled();expect(agentCatalogApi.connect).not.toHaveBeenCalled();expect(render().notice).toBe('');
    });
    it('Старый callback после смены роли не запускает запрос',async()=>{
        const old=render();ui.owner='reader';await old.mutate({kind:'assign',agent:agent(),revision:3});expect(agentCatalogApi.assign).not.toHaveBeenCalled();await flush();
    });
});
