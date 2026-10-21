import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {bridgeSourceApi,type IBridgeSource,type IBridgeSourceImportIntent} from '../src/features/McpBridge/bridgeSource';
import {useBridgeSourceImport} from '../src/features/McpBridge/useBridgeSourceImport';
import type {IAssetImport} from '../src/features/AssetSources/types';

const owner=vi.hoisted(()=>({scope:'main-admin',capture:()=>{const scope=owner.scope;return()=>owner.scope===scope;}}));
const hooks=vi.hoisted(()=>{
 let cursor=0;const slots:Array<{value?:unknown;dependencies?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
 const same=(a:unknown[]|undefined,b:unknown[]|undefined)=>!!a&&!!b&&a.length===b.length&&b.every((v,i)=>Object.is(v,a[i]));
 return {
  begin:()=>{cursor=0;},commit:()=>{effects.splice(0).forEach(effect=>effect());},dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
  useState<T>(initial:T|(()=>T)){const slot=slots[cursor++]??={value:typeof initial==='function'?(initial as()=>T)():initial};return[slot.value,(next:T|((previous:T)=>T))=>{slot.value=typeof next==='function'?(next as(previous:T)=>T)(slot.value as T):next;}];},
  useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
  useCallback<T>(callback:T,dependencies:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.dependencies,dependencies))return previous.value;slots[index]={value:callback,dependencies};return callback;},
  useEffect(effect:()=>void|(()=>void),dependencies?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.dependencies,dependencies))return;const slot=slots[index]={dependencies};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
 };
});
vi.mock('react',()=>({useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:owner.scope,captureOwner:owner.capture})}));
vi.mock('../src/features/McpBridge/bridgeSource',async importOriginal=>({...await importOriginal<typeof import('../src/features/McpBridge/bridgeSource')>(),
 bridgeSourceApi:{import:vi.fn(),job:vi.fn(),action:vi.fn(),resolve:vi.fn()}}));

const requestKey='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const source:IBridgeSource={url:'https://github.com/example/assets',revision:3,available:{assetId:'neurocenter-bridge',version:'0.10.0',buildId:'b'.repeat(64),repositoryCommit:'a'.repeat(40),targets:['darwin-arm64']}};
const intent:IBridgeSourceImportIntent={expectedRevision:3,commit:'a'.repeat(40),assetId:'neurocenter-bridge',requestKey};
const job=(state:IAssetImport['state']='QUEUED',id=jobId):IAssetImport=>({id,state,message:'QA import',planDigest:'c'.repeat(64),items:[]});
let storage:Map<string,string>;const completed=vi.fn();
const key=()=> 'bridge-source-import:'+encodeURIComponent(owner.scope);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function render(){hooks.begin();const state=useBridgeSourceImport(completed);hooks.commit();return state;}
async function settle(){for(let i=0;i<8;i++)await Promise.resolve();render();return render();}

beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks();owner.scope='main-admin';storage=new Map();
 vi.stubGlobal('localStorage',{getItem:(name:string)=>storage.get(name)??null,setItem:(name:string,value:string)=>storage.set(name,value),removeItem:(name:string)=>storage.delete(name)});
 vi.mocked(bridgeSourceApi.job).mockResolvedValue(job());
 vi.mocked(bridgeSourceApi.import).mockResolvedValue(job());
 vi.mocked(bridgeSourceApi.action).mockResolvedValue(job('CANCELLED'));
 vi.mocked(bridgeSourceApi.resolve).mockResolvedValue(job());
});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();vi.useRealTimers();});

describe('Устойчивый импорт моста через сохранённое точное намерение',()=>{
 it('После потери ответа повторяет тот же requestKey и не разрешает новый независимый запрос',async()=>{
  vi.mocked(bridgeSourceApi.import).mockRejectedValueOnce(new Error('ACK lost'));
  render();await render().start(source);let state=await settle();
  const original=vi.mocked(bridgeSourceApi.import).mock.calls[0][0];
  expect(state.blocked).toBe(true);expect(state.job).toBeUndefined();expect(state.intent?.requestKey).toBe(original.requestKey);
  await state.start({...source,revision:4});state=await settle();
  expect(bridgeSourceApi.import).toHaveBeenCalledTimes(2);expect(vi.mocked(bridgeSourceApi.import).mock.calls[1][0].requestKey).toBe(original.requestKey);
  expect(state.job?.id).toBe(jobId);
 });
 it('Предыдущий завершённый результат не скрывает неопределённый новый POST после потери ACK',async()=>{
  vi.mocked(bridgeSourceApi.import).mockResolvedValueOnce(job('SUCCEEDED')).mockRejectedValueOnce(new Error('Second ACK lost'));
  render();await render().start(source);expect((await settle()).job?.state).toBe('SUCCEEDED');
  await render().start({...source,revision:4});let state=await settle();
  const second=vi.mocked(bridgeSourceApi.import).mock.calls[1][0];
  expect(state.job).toBeUndefined();expect(state.blocked).toBe(true);expect(state.error).toBeTruthy();expect(state.intent?.requestKey).toBe(second.requestKey);
  await state.repeat();state=await settle();expect(state.job?.state).toBe('QUEUED');
  expect(vi.mocked(bridgeSourceApi.import).mock.calls[2][0].requestKey).toBe(second.requestKey);
 });
 it('Reload читает сохранённую операцию без автоматического POST',async()=>{
  storage.set(key(),JSON.stringify(intent));render();const state=await settle();
  expect(bridgeSourceApi.job).toHaveBeenCalledWith(intent);expect(bridgeSourceApi.import).not.toHaveBeenCalled();
  expect(state.job?.id).toBe(jobId);expect(state.intent?.requestKey).toBe(requestKey);
 });
 it('Если потерянный запрос ещё не найден, ручной повтор сохраняет его прежний ключ',async()=>{
  storage.set(key(),JSON.stringify(intent));vi.mocked(bridgeSourceApi.job).mockRejectedValueOnce(new Error('Not found'));
  render();let state=await settle();expect(state.job).toBeUndefined();expect(state.blocked).toBe(true);expect(state.error).toBeTruthy();
  expect(bridgeSourceApi.import).not.toHaveBeenCalled();await state.repeat();state=await settle();
  expect(vi.mocked(bridgeSourceApi.import).mock.calls[0][0].requestKey).toBe(requestKey);expect(state.job?.state).toBe('QUEUED');
 });
 it('Двойное нажатие во время POST не создаёт второй импорт',async()=>{
  const pending=deferred<IAssetImport>();vi.mocked(bridgeSourceApi.import).mockReturnValueOnce(pending.promise);
  render();const state=render(),one=state.start(source),two=state.start(source);expect(bridgeSourceApi.import).toHaveBeenCalledOnce();
  pending.resolve(job());await Promise.all([one,two]);expect((await settle()).job?.id).toBe(jobId);
 });
 it('Явный отказ до постановки очищает намерение и разрешает исправить источник',async()=>{
  vi.mocked(bridgeSourceApi.import).mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Source changed'}}});
  render();await render().start(source);const state=await settle();
  expect(state.intent).toBeUndefined();expect(state.blocked).toBe(false);expect(storage.has(key())).toBe(false);
 });
 it('Смена пользователя отсекает поздний POST и не переносит операцию в новую сессию',async()=>{
  const old=deferred<IAssetImport>();vi.mocked(bridgeSourceApi.import).mockReturnValueOnce(old.promise);
  render();const first=render().start(source);owner.scope='another-user';render();await settle();
  old.resolve(job('SUCCEEDED'));await first;const state=await settle();
  expect(state.job).toBeUndefined();expect(state.intent).toBeUndefined();expect(state.busy).toBe(false);expect(completed).not.toHaveBeenCalled();
  expect(storage.has(key())).toBe(false);
 });
 it('Размонтирование отсекает поздний результат даже при неизменном владельце',async()=>{
  const old=deferred<IAssetImport>();vi.mocked(bridgeSourceApi.import).mockReturnValueOnce(old.promise);
  render();const pending=render().start(source),saved=storage.get(key());hooks.dispose();
  old.resolve(job('SUCCEEDED'));await pending;expect(storage.get(key())).toBe(saved);expect(completed).not.toHaveBeenCalled();
 });
 it('Подтверждение нового источника передаёт точный digest сохранённого конфликта',async()=>{
  vi.mocked(bridgeSourceApi.import).mockResolvedValueOnce(job('NEEDS_INPUT'));
  render();await render().start(source);const state=await settle();
  expect(await state.resolve()).toBe(true);expect(bridgeSourceApi.resolve).toHaveBeenCalledWith(jobId,job('NEEDS_INPUT').planDigest);
  expect((await settle()).job?.state).toBe('QUEUED');expect(bridgeSourceApi.import).toHaveBeenCalledOnce();
 });
 it('Позднее подтверждение источника не переносит результат в другую сессию',async()=>{
  vi.mocked(bridgeSourceApi.import).mockResolvedValueOnce(job('NEEDS_INPUT'));
  render();await render().start(source);const state=await settle();completed.mockClear();
  const response=deferred<IAssetImport>();vi.mocked(bridgeSourceApi.resolve).mockReturnValueOnce(response.promise);
  const pending=state.resolve();owner.scope='another-user';render();await settle();
  response.resolve(job('SUCCEEDED'));expect(await pending).toBe(false);expect((await settle()).job).toBeUndefined();expect(completed).not.toHaveBeenCalled();
 });
});
