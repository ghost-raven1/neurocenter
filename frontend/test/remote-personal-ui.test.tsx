// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RemoteProviderAccess} from '../src/features/RemoteProviderAccess/RemoteProviderAccess';
import {personalProviderApi as api} from '../src/features/RemoteProviderAccess/api';
import {durableJournalOwner} from '../src/features/UserBlock/durableJournalOwner';
import type {PersonalProviderReceipt,PersonalProviderView} from '../src/features/RemoteProviderAccess/model';
const h=vi.hoisted(()=>({scope:'alice-grants-v1',email:'alice@test',role:'Разработчик',enabled:true,captures:new Map<string,()=>()=>boolean>()}));
vi.mock('../src/features/RemoteProviderAccess/api',()=>({personalProviderApi:{read:vi.fn(),receipt:vi.fn(),write:vi.fn()}}));
vi.mock('../src/core/api',()=>({baseApi:{defaults:{baseURL:'https://personal.test'}}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const scope=h.scope;let capture=h.captures.get(scope);if(!capture){capture=()=>()=>h.scope===scope;h.captures.set(scope,capture);}return{scope,captureOwner:capture};}}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{id:h.email,email:h.email,activeRole:h.role,userRoles:[h.role]}}})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:'Личный доступ выключен',known:true,loading:false})}));
const id='model-personal',providerId='a'.repeat(64);
let root:Root,container:HTMLDivElement,view:PersonalProviderView,receipts:Map<string,PersonalProviderReceipt>;
const render=async(modelId=id)=>{await act(async()=>root.render(createElement(RemoteProviderAccess,{modelId})));};
const eventually=async(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await Promise.resolve();});check();},{timeout:1500,interval:5});
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!;
const click=async(text:string)=>{expect(button(text)).toBeTruthy();await act(async()=>button(text).click());};
async function secret(value:string){const input=container.querySelector<HTMLInputElement>('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
const journal=()=>`neurocenter:personal-provider:v1:${durableJournalOwner({id:h.email,email:h.email,activeRole:h.role},'https://personal.test')}:${id}`;
beforeEach(()=>{
    vi.clearAllMocks();h.scope='alice-grants-v1';h.email='alice@test';h.role='Разработчик';h.enabled=true;h.captures.clear();localStorage.clear();receipts=new Map();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',{randomUUID:()=>webcrypto.randomUUID()});vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
    view={modelId:id,providerId,providerUrl:'https://provider.test/v1',connectionRevision:1,credentialRevision:0,authMode:'required',hasKey:false,updatedAt:null,canStoreKey:true,legacySharedKeyRetained:true};
    vi.mocked(api.read).mockImplementation(async modelId=>({...view,modelId}));vi.mocked(api.receipt).mockImplementation(async(_id,key)=>receipts.get(key)??null);
    vi.mocked(api.write).mockImplementation(async(modelId,intent)=>{const receipt={modelId,providerId:intent.providerId,requestKey:intent.requestKey,requestHash:'b'.repeat(64),connectionRevision:intent.expectedConnectionRevision,credentialRevision:intent.expectedCredentialRevision+1,hasKey:intent.action==='save',acceptedAt:'2026-10-29T12:00:00Z'};receipts.set(intent.requestKey,receipt);view={...view,hasKey:receipt.hasKey,credentialRevision:receipt.credentialRevision};return receipt;});
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();vi.unstubAllGlobals();});

it('shows recipient and a personal password input, saves safely without provider checks and removes after confirmation',async()=>{
    await render();await eventually(()=>expect(container.textContent).toContain('https://provider.test/v1'));expect(container.querySelector('input')?.type).toBe('password');
    await secret('my-private-key');expect(container.textContent).not.toContain('my-private-key');await click('Сохранить мой ключ');await eventually(()=>expect(container.textContent).toContain('Личный ключ сохранён'));
    expect(api.write).toHaveBeenCalledWith(id,expect.objectContaining({action:'save'}),'my-private-key',expect.any(AbortSignal));expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('');expect(localStorage.length).toBe(0);
    await click('Удалить мой ключ');await eventually(()=>expect(button('Удалить')).toBeTruthy());await click('Удалить');await eventually(()=>expect(container.textContent).toContain('Удаление личного ключа подтверждено'));
    expect(vi.mocked(api.write).mock.calls[1][1].action).toBe('delete');
});
it('none hides the key input and optional explains anonymous requests while retaining saved-key deletion',async()=>{
    view={...view,authMode:'none',hasKey:true};await render();await eventually(()=>expect(container.textContent).toContain('Этому API ключ не отправляется'));expect(container.querySelector('input')).toBeNull();expect(button('Удалить мой ключ')).toBeTruthy();
    view={...view,authMode:'optional',hasKey:false};await click('Обновить сведения');await eventually(()=>expect(container.textContent).toContain('Ключ необязателен'));expect(container.querySelector('input')).toBeTruthy();expect(api.write).not.toHaveBeenCalled();
});
it('network error keeps the field in memory and only metadata in the durable journal',async()=>{
    await render();await eventually(()=>expect(container.querySelector('input')).toBeTruthy());await secret('secret-stays-in-memory');vi.mocked(api.write).mockRejectedValueOnce(Error('Сеть недоступна'));await click('Сохранить мой ключ');
    await eventually(()=>expect(container.textContent).toContain('Сеть недоступна'));expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('secret-stays-in-memory');
    expect(localStorage.getItem(journal())).not.toContain('secret-stays-in-memory');expect(button('Проверить сохранение')).toBeTruthy();expect(button('Повторить прежнюю операцию')).toBeTruthy();
});
it('fresh grant changes fence the old draft while a stable principal recovers its original UUID after 403',async()=>{
    await render();await eventually(()=>expect(container.querySelector('input')).toBeTruthy());await secret('alice-secret');let finish!:(value:PersonalProviderReceipt)=>void;
    vi.mocked(api.write).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));await click('Сохранить мой ключ');const intent=vi.mocked(api.write).mock.calls[0][1],saved=localStorage.getItem(journal());
    h.scope='alice-grants-v2';await render();await eventually(()=>expect(button('Проверить сохранение')).toBeTruthy());expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('');expect(localStorage.getItem(journal())).toBe(saved);
    const receipt={modelId:id,providerId,requestKey:intent.requestKey,requestHash:'b'.repeat(64),connectionRevision:1,credentialRevision:1,hasKey:true,acceptedAt:'2026-10-29T12:00:00Z'};receipts.set(intent.requestKey,receipt);await act(async()=>finish(receipt));
    expect(button('Проверить сохранение')).toBeTruthy();await click('Проверить сохранение');await eventually(()=>expect(container.textContent).toContain('Предыдущее сохранение личного ключа подтверждено'));expect(api.write).toHaveBeenCalledOnce();
});
it('a different account never displays or dispatches the former account pending secret',async()=>{
    await render();await eventually(()=>expect(container.querySelector('input')).toBeTruthy());await secret('alice-only');vi.mocked(api.write).mockRejectedValueOnce(Error('network'));await click('Сохранить мой ключ');const aliceJournal=localStorage.getItem(journal());
    h.scope='bob-grants-v1';h.email='bob@test';await render();await eventually(()=>expect(container.querySelector('input')).toBeTruthy());expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('');expect(button('Проверить сохранение')).toBeUndefined();expect(localStorage.getItem(journal())).toBeNull();
    expect([...Array.from({length:localStorage.length},(_,i)=>localStorage.getItem(localStorage.key(i)!))]).toContain(aliceJournal);expect(api.write).toHaveBeenCalledOnce();
});
it('corrupt journal remains visible and blocks replacement; OFF keeps readable current status and observers do not mount unavailable actions',async()=>{
    localStorage.setItem(journal(),'{corrupt');await render();await eventually(()=>expect(container.textContent).toContain('Журнал личного доступа повреждён'));await secret('new');expect(button('Сохранить мой ключ').disabled).toBe(true);expect(localStorage.getItem(journal())).toBe('{corrupt');expect(api.write).not.toHaveBeenCalled();
    h.scope='off';h.enabled=false;await render();await eventually(()=>expect(container.textContent).toContain('Личный доступ выключен'));expect(container.textContent).toContain('https://provider.test/v1');
    h.scope='observer';h.role='Наблюдатель';vi.mocked(api.read).mockClear();await render();expect(container.textContent).toBe('');expect(api.read).not.toHaveBeenCalled();
});
