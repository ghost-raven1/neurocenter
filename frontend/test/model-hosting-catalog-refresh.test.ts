import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';
import {useModelHosting} from '../src/features/ModelCatalog/useModelHosting';
import type {ICatalogModel,IModelHosting} from '../src/features/ModelCatalog/types';

// Preserve callback/effect dependencies across renders so a stable model cannot fake a refresh.
const hooks=vi.hoisted(()=>{
 let cursor=0;
 const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
 const same=(a?:unknown[],b?:unknown[])=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
  state<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(value:T)=>{slot.value=value;}];},
  ref<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
  callback(value:unknown,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={value,deps};return slots[index].value;},
  effect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
 };
});
const owner=vi.hoisted(()=>{let current=true;return {set:(value:boolean)=>{current=value;},capture:()=>()=>current};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useRef:hooks.ref,useCallback:hooks.callback,useEffect:hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:owner.capture})}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{hosting:vi.fn(),operate:vi.fn()}}));

const model={id:'model-five',revision:3,runtime:'remote-openai'} as ICatalogModel;
const failed:IModelHosting={state:'error',message:'Модель вернула несовместимые векторы.',checkedAt:'2026-10-21T01:00:00Z'};
const ready:IModelHosting={state:'ready',message:'Подключение работает.',checkedAt:'2026-10-21T01:01:00Z'};
let activeModel=model,current:ReturnType<typeof useModelHosting>;
function Probe(){current=useModelHosting(activeModel);return null;}
function render(){hooks.begin();renderToStaticMarkup(createElement(Probe));hooks.commit();return current;}
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function deferred(){let resolve!:(value:IModelHosting)=>void;const promise=new Promise<IModelHosting>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();owner.set(true);activeModel=model;});
afterEach(()=>{hooks.dispose();vi.restoreAllMocks();});

it('Свежий catalog object с теми же id/revision перечитывает hosting после success без probe и запросов на обычный render',async()=>{
 const interval=vi.spyOn(globalThis,'setInterval');vi.mocked(modelCatalogApi.hosting).mockResolvedValueOnce(failed).mockResolvedValueOnce(ready);
 render();await flush();expect(render().hosting).toEqual(failed);render();expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(1);
 activeModel={...model};render();await flush();expect(render().hosting).toEqual(ready);render();
 expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);expect(modelCatalogApi.hosting).toHaveBeenLastCalledWith(model.id);expect(modelCatalogApi.operate).not.toHaveBeenCalled();expect(interval).not.toHaveBeenCalled();
});
it('Поздний ответ прежнего catalog object не возвращает старую ошибку поверх свежего чтения',async()=>{
 const old=deferred(),fresh=deferred();vi.mocked(modelCatalogApi.hosting).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 render();activeModel={...model};render();expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(1);
 old.resolve(failed);await flush();expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);expect(render().hosting).toBeNull();
 fresh.resolve(ready);await flush();expect(render().hosting).toEqual(ready);expect(modelCatalogApi.operate).not.toHaveBeenCalled();
});
it('Новый catalog refresh не принимает поздний ответ после потери владельца',async()=>{
 const fresh=deferred();vi.mocked(modelCatalogApi.hosting).mockResolvedValueOnce(failed).mockReturnValueOnce(fresh.promise);
 render();await flush();render();activeModel={...model};render();owner.set(false);fresh.resolve(ready);await flush();
 expect(render().hosting).toBeNull();expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(2);expect(modelCatalogApi.operate).not.toHaveBeenCalled();
});
it.each([true,false])('Свежий catalog object во время операции перечитывается после lock только при действующем owner=%s',async owns=>{
 const operation=deferred();vi.mocked(modelCatalogApi.hosting).mockResolvedValueOnce(failed).mockResolvedValueOnce(ready);vi.mocked(modelCatalogApi.operate).mockReturnValueOnce(operation.promise);
 render();await flush();render();const running=current.operate('check');activeModel={...model};render();render();
 expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(1);owner.set(owns);operation.resolve(ready);await running;await flush();
 expect(render().hosting).toEqual(owns?ready:null);expect(modelCatalogApi.hosting).toHaveBeenCalledTimes(owns?2:1);expect(modelCatalogApi.operate).toHaveBeenCalledTimes(1);
});
