import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useChatIndex} from '../src/features/ModelChat/useChatIndex';
import {modelChatApi} from '../src/features/ModelChat/api';
import {detail} from './model-chat-fixtures';
import type {IModelChatConversation} from '../src/features/ModelChat/types';
const hooks=vi.hoisted(()=>{let cursor=0,deferred=false;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[],updates:Array<()=>void>=[];const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,i)=>Object.is(value,a[i]));return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),defer:()=>{deferred=true;},flushUpdates:()=>{updates.splice(0).forEach(update=>update());},dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;updates.length=0;deferred=false;},state<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(value:T|((previous:unknown)=>T))=>{const apply=()=>{slot.value=typeof value==='function'?(value as (previous:unknown)=>T)(slot.value):value;};if(deferred)updates.push(apply);else apply();}];},ref<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},callback<T>(value:T,deps:unknown[]){const index=cursor++,old=slots[index];if(old&&same(old.deps,deps))return old.value;slots[index]={value,deps};return value;},effect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,old=slots[index];if(old&&same(old.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});}};});
const identity=vi.hoisted(()=>({owner:'alice',captures:new Map<string,()=>()=>boolean>()}));
vi.mock('react',()=>({useState:hooks.state,useRef:hooks.ref,useCallback:hooks.callback,useEffect:hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{let capture=identity.captures.get(identity.owner);if(!capture){const owner=identity.owner;capture=()=>()=>owner===identity.owner;identity.captures.set(owner,capture);}return{scope:identity.owner,captureOwner:capture};}}));
vi.mock('../src/features/ModelChat/api',()=>({modelChatApi:{list:vi.fn()}}));
let enabled=true,projectId:string|undefined='prj-one';
const render=()=>{hooks.begin();const value=useChatIndex(projectId,enabled);hooks.commit();return value;};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
const conversation=(patch:Partial<IModelChatConversation>={})=>({...detail().conversation,...patch});
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();identity.owner='alice';identity.captures.clear();enabled=true;projectId='prj-one';vi.mocked(modelChatApi.list).mockResolvedValue([]);});
afterEach(()=>hooks.dispose());

describe('Project-wide личный индекс диалогов: порядок сохранения и readonly запросов',()=>{
    it('Отключённый workspace не читает индекс, включение читает весь project scope без model фильтра',async()=>{
        enabled=false;let value=render();await value.refresh();expect(modelChatApi.list).not.toHaveBeenCalled();enabled=true;render();await flush();expect(modelChatApi.list).toHaveBeenCalledWith(undefined,'prj-one',expect.any(AbortSignal));expect(render().loading).toBe(false);
    });
    it('Новая refresh отменяет предыдущую, поздний успех не перезаписывает актуальный список',async()=>{
        const old=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(old.promise).mockResolvedValueOnce([conversation({id:'current'})]);const value=render(),signal=vi.mocked(modelChatApi.list).mock.calls[0][2];await value.refresh();expect(signal.aborted).toBe(true);old.resolve([conversation({id:'stale'})]);await flush();expect(render().items.map(item=>item.id)).toEqual(['current']);
    });
    it('Локально сохранённая новая revision выигрывает у устаревшего ответа для той же записи',async()=>{
        const pending=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise);const value=render();value.changed(conversation({revision:5,title:'Новое имя'}));pending.resolve([conversation({revision:1,title:'Старое имя'})]);await flush();expect(render().items[0]).toMatchObject({revision:5,title:'Новое имя'});
    });
    it('Сохранённая новая запись не исчезает, когда старый list snapshot ещё её не содержит',async()=>{
        const pending=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise);const value=render();value.changed(conversation({id:'new-chat',revision:1,title:'Только что создан'}));pending.resolve([]);await flush();expect(render().items.map(item=>item.id)).toEqual(['new-chat']);
    });
    it('Отложенный updater старого snapshot сохраняет новую запись, даже если следующая refresh уже очистила свой журнал',async()=>{
        const first=deferred<IModelChatConversation[]>(),second=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);const value=render();hooks.defer();value.changed(conversation({id:'new-chat',revision:1}));first.resolve([]);await flush();const next=value.refresh();hooks.flushUpdates();expect(render().items.map(item=>item.id)).toEqual(['new-chat']);second.reject(new Error('Второй запрос недоступен'));await next;hooks.flushUpdates();expect(render().items.map(item=>item.id)).toEqual(['new-chat']);
    });
    it('Fresh list после удаления удаляет запись из индекса; changed(null) явно перечитывает его',async()=>{
        vi.mocked(modelChatApi.list).mockResolvedValueOnce([conversation()]);render();await flush();let value=render();expect(value.items).toHaveLength(1);vi.mocked(modelChatApi.list).mockResolvedValueOnce([]);value.changed(null);await flush();value=render();expect(value.items).toEqual([]);expect(modelChatApi.list).toHaveBeenCalledTimes(2);
    });
    it('Старый snapshot не возвращает удалённую запись после changed(null), даже если приходит последним',async()=>{
        vi.mocked(modelChatApi.list).mockResolvedValueOnce([conversation()]);render();await flush();const stale=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(stale.promise);void render().refresh();const staleSignal=vi.mocked(modelChatApi.list).mock.calls[1][2];vi.mocked(modelChatApi.list).mockResolvedValueOnce([]);render().changed(null);await flush();expect(staleSignal.aborted).toBe(true);stale.resolve([conversation()]);await flush();expect(render().items).toEqual([]);
    });
    it('Смена владельца/проекта скрывает старые items сразу, старый changed callback не переносит их обратно',async()=>{
        vi.mocked(modelChatApi.list).mockResolvedValueOnce([conversation()]);render();await flush();const old=render();expect(old.items).toHaveLength(1);identity.owner='bob';projectId='prj-two';const pending=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise);expect(render().items).toEqual([]);old.changed(conversation({id:'PRIVATE OLD'}));expect(render().items).toEqual([]);pending.resolve([conversation({id:'bob',projectId:'prj-two'})]);await flush();expect(render().items.map(item=>item.id)).toEqual(['bob']);
    });
    it('Ошибка refresh сохраняет последнюю историю, успешный retry снимает ошибку',async()=>{
        vi.mocked(modelChatApi.list).mockResolvedValueOnce([conversation()]);render();await flush();vi.mocked(modelChatApi.list).mockRejectedValueOnce(new Error('Индекс недоступен'));await render().refresh();let value=render();expect(value.error).toBe('Индекс недоступен');expect(value.items).toHaveLength(1);vi.mocked(modelChatApi.list).mockResolvedValueOnce([conversation({revision:6})]);await value.refresh();value=render();expect(value.error).toBe('');expect(value.items[0].revision).toBe(6);
    });
    it.each(['resolve','reject']as const)('До auth render чужой поздний %s не меняет данные/ошибку',async(outcome)=>{
        const pending=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise);render();identity.owner='bob';if(outcome==='resolve')pending.resolve([conversation()]);else pending.reject(new Error('PRIVATE FAILURE'));await flush();expect(render().items).toEqual([]);expect(render().error).toBe('');
    });
    it('Смена project scope и unmount снимают активный list, late rejected transport не портит новое состояние',async()=>{
        const pending=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(pending.promise);render();const signal=vi.mocked(modelChatApi.list).mock.calls[0][2];projectId='prj-two';render();expect(signal.aborted).toBe(true);await flush();pending.reject(new Error('Old aborted request'));await flush();expect(render().error).toBe('');const active=deferred<IModelChatConversation[]>();vi.mocked(modelChatApi.list).mockReturnValueOnce(active.promise);void render().refresh();const current=vi.mocked(modelChatApi.list).mock.calls.at(-1)![2];hooks.dispose();expect(current.aborted).toBe(true);active.resolve([]);await flush();
    });
});
