// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PluginAutoUpdateControl} from '../src/features/PluginAutoUpdates/PluginAutoUpdateControl';
import {pluginAutoUpdateApi,type PluginUpdatePolicy} from '../src/features/PluginAutoUpdates/api';
import {bridgeApi,type IBridgeInstallation} from '../src/features/McpBridge/api';

const ui=vi.hoisted(()=>({scope:'owner-one',epoch:0,enabled:true,changed:vi.fn(),captureOwner:()=>{const epoch=ui.epoch;return()=>epoch===ui.epoch;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:ui.scope,captureOwner:ui.captureOwner})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:ui.enabled,reason:'Автообновление отключено администратором.'})}));
vi.mock('../src/features/PluginAutoUpdates/api',()=>({pluginAutoUpdateApi:{read:vi.fn(),save:vi.fn()}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{cancel:vi.fn()}}));
const installation={deviceId:'computer-one',projectId:'prj-one',bindingId:'a'.repeat(64),assetId:'plugin-one',assetKind:'plugin',name:'Мой плагин',version:1} as IBridgeInstallation;
const policy=(enabled=true):PluginUpdatePolicy=>({id:'own-policy',enabled,revision:1,status:'waiting',message:'Режим сохранён',checkedAt:null,nextCheckAt:null});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};}
let host:HTMLDivElement,root:Root;
beforeEach(()=>{
 vi.resetAllMocks();ui.scope='owner-one';ui.epoch=0;ui.enabled=true;
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const computed=window.getComputedStyle.bind(window);vi.spyOn(window,'getComputedStyle').mockImplementation(element=>computed(element));
 vi.stubGlobal('matchMedia',(query:string)=>({matches:false,media:query,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
 host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
 vi.mocked(pluginAutoUpdateApi.read).mockResolvedValue(null);vi.mocked(pluginAutoUpdateApi.save).mockResolvedValue(policy());vi.mocked(bridgeApi.cancel).mockResolvedValue({ok:true} as never);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
const render=async(item=installation,canManage=true)=>{await act(async()=>root.render(createElement(PluginAutoUpdateControl,{installation:item,canManage,onChanged:ui.changed})));};
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text)!;
const click=async(text:string)=>{const item=button(text);expect(item).toBeTruthy();await act(async()=>item.click());};
const toggle=async()=>{const control=document.querySelector<HTMLButtonElement>('button[role="switch"]')!;expect(control).toBeTruthy();await act(async()=>control.click());};
const open=async()=>{await render();await click('Автообновление');};

describe('Installed plugin approved-version auto-update control',()=>{
 it('loads only when opened and explains that catalog latest still needs project assignment and approval',async()=>{
  await render();expect(pluginAutoUpdateApi.read).not.toHaveBeenCalled();await click('Автообновление');expect(pluginAutoUpdateApi.read).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('закреплённую и одобренную');expect(document.body.textContent).toContain('общем каталоге не меняет');
 });
 it('retains the exact mutation key and chosen mode after an unknown save ACK',async()=>{
  vi.mocked(pluginAutoUpdateApi.save).mockRejectedValueOnce(Error('Контролируемая потеря подтверждения'));await open();await toggle();
  expect(document.body.textContent).toContain('Ваш выбор: включить');const first=vi.mocked(pluginAutoUpdateApi.save).mock.calls[0][0];
  await click('Повторить сохранение');expect(vi.mocked(pluginAutoUpdateApi.save).mock.calls[1][0]).toEqual(first);expect(ui.changed).toHaveBeenCalledOnce();
  expect(button('Повторить сохранение')).toBeUndefined();expect(document.querySelector('button[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
 });
 it('keeps an accepted mode accepted even when the surrounding refresh callback throws',async()=>{
  ui.changed.mockImplementation(()=>{throw Error('Unrelated parent refresh failure');});await open();await toggle();
  expect(document.querySelector('button[role="switch"]')?.getAttribute('aria-checked')).toBe('true');expect(button('Повторить сохранение')).toBeUndefined();
  expect(document.body.textContent).not.toContain('Unrelated parent refresh failure');
 });
 it('feature OFF preserves policy read, disable, last job and cancellation while rejecting new enable',async()=>{
  ui.enabled=false;vi.mocked(pluginAutoUpdateApi.read).mockResolvedValue({...policy(),job:{id:'own-job',state:'queued',message:'Ждёт моста'}});
  vi.mocked(pluginAutoUpdateApi.save).mockResolvedValue(policy(false));await open();expect(document.body.textContent).toContain('Ждёт моста');
  expect(button('Проверить сейчас').disabled).toBe(true);await click('Отменить задание');expect(bridgeApi.cancel).toHaveBeenCalledExactlyOnceWith('own-job');
  await toggle();expect(vi.mocked(pluginAutoUpdateApi.save).mock.calls[0][0].enabled).toBe(false);
  expect(document.querySelector<HTMLButtonElement>('button[role="switch"]')?.disabled).toBe(true);
 });
 it.each(['save','cancel'] as const)('ignores a late %s completion after the actor changes, before the next render',async kind=>{
  vi.mocked(pluginAutoUpdateApi.read).mockResolvedValue({...policy(),job:{id:'old-job',state:'queued',message:'Old private job'}});await open();
  const pending=deferred<never>();if(kind==='save'){vi.mocked(pluginAutoUpdateApi.save).mockReturnValueOnce(pending.promise);await toggle();}
  else{vi.mocked(bridgeApi.cancel).mockReturnValueOnce(pending.promise);await click('Отменить задание');}
  ui.scope='owner-two';ui.epoch++;await act(async()=>pending.resolve(policy(false) as never));expect(ui.changed).not.toHaveBeenCalled();
  vi.mocked(pluginAutoUpdateApi.read).mockResolvedValue(null);await render();expect(document.body.textContent).not.toContain('Old private job');
 });
 it('aborts an old folder read and refuses its late private policy after the target changes',async()=>{
  const pending=deferred<PluginUpdatePolicy|null>();vi.mocked(pluginAutoUpdateApi.read).mockReturnValueOnce(pending.promise);await open();
  const signal=vi.mocked(pluginAutoUpdateApi.read).mock.calls[0][1];await render({...installation,bindingId:'b'.repeat(64)});expect(signal.aborted).toBe(true);
  await act(async()=>pending.resolve({...policy(),message:'Private old folder status'}));expect(document.body.textContent).not.toContain('Private old folder status');
 });
});
