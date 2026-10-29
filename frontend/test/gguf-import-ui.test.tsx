// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {GgufImportModal} from '../src/features/GgufImport/GgufImportModal';
import {ggufImportApi as api} from '../src/features/GgufImport/api';
import {durableJournalOwner} from '../src/features/UserBlock/durableJournalOwner';
import base from '../src/core/api/base';
import {id,imported,key,policy,receipt} from './gguf-import.fixture';

const h=vi.hoisted(()=>({scope:'alice-grants1',email:'alice@example.test',enabled:true,role:'Главный админ',captures:new Map<string,()=>()=>boolean>()}));
vi.mock('../src/features/GgufImport/api',()=>({ggufImportApi:{limits:vi.fn(),lookup:vi.fn(),create:vi.fn(),upload:vi.fn(),accept:vi.fn(),cancel:vi.fn(),model:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const owner=h.scope;let capture=h.captures.get(owner);if(!capture){capture=()=>()=>owner===h.scope;h.captures.set(owner,capture);}return {scope:owner,captureOwner:capture};
}}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{id:1,email:h.email,activeRole:h.role}}})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:'Импорт GGUF выключен',loading:false,known:true,refresh:vi.fn()})}));
let root:Root,container:HTMLDivElement;const onImported=vi.fn();
const render=async()=>{await act(async()=>root.render(createElement(GgufImportModal,{onClose:vi.fn(),onImported})));};
const eventually=async(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await Promise.resolve();});check();},{timeout:2000,interval:10});
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!;
const click=async(text:string)=>{expect(button(text)).toBeTruthy();await act(async()=>button(text).click());};
const choose=async(name='owned.gguf',content='gguf')=>{
    const file=new File([content],name);Object.defineProperty(file,'arrayBuffer',{value:()=>{throw Error('Whole-file conversion forbidden');}});
    const input=document.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(input,'files',{configurable:true,value:[file]});
    await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));return file;
};
beforeEach(()=>{
    vi.clearAllMocks();localStorage.clear();h.scope='alice-grants1';h.email='alice@example.test';h.role='Главный админ';h.enabled=true;h.captures.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',{randomUUID:()=>key});
    vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
    const computed=window.getComputedStyle.bind(window);vi.spyOn(window,'getComputedStyle').mockImplementation(element=>computed(element));
    vi.mocked(api.limits).mockResolvedValue(policy);vi.mocked(api.lookup).mockRejectedValue({response:{status:404}});vi.mocked(api.create).mockResolvedValue(receipt());
    vi.mocked(api.upload).mockResolvedValue(receipt('READY'));vi.mocked(api.accept).mockResolvedValue(imported());vi.mocked(api.cancel).mockResolvedValue(receipt('CANCELLED'));vi.mocked(api.model).mockResolvedValue(imported());
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('uploads a real File then separates verified GGUF, catalog acceptance and runtime readiness',async()=>{
    await render();await eventually(()=>expect(button('Выбрать файл GGUF').disabled).toBe(false));const file=await choose();await click('Загрузить и проверить');
    await eventually(()=>expect(document.body.textContent).toContain('GGUF проверен сервером'));expect(api.upload).toHaveBeenCalledWith(id,file,expect.any(AbortSignal),expect.any(Function));
    expect(onImported).not.toHaveBeenCalled();expect(document.body.textContent).toContain('llama');await click('Добавить модель в каталог');
    await eventually(()=>expect(document.body.textContent).toContain('Модель добавлена в каталог'));expect(document.body.textContent).toContain('запустите хостинг');expect(onImported).toHaveBeenCalledOnce();
});
it('lost raw ACK keeps the file and OFF still allows receipt recovery and cancellation',async()=>{
    await render();await eventually(()=>expect(button('Выбрать файл GGUF').disabled).toBe(false));await choose();vi.mocked(api.upload).mockRejectedValueOnce(Error('Response lost'));await click('Загрузить и проверить');
    await eventually(()=>expect(document.body.textContent).toContain('Response lost'));expect(document.body.textContent).toContain('owned.gguf');h.enabled=false;vi.mocked(api.lookup).mockResolvedValue(receipt('READY'));await render();await click('Проверить состояние');
    await eventually(()=>expect(document.body.textContent).toContain('GGUF проверен сервером'));expect(button('Добавить модель в каталог').disabled).toBe(true);expect(button('Отменить импорт').disabled).toBe(false);await click('Отменить импорт');
    await eventually(()=>expect(document.body.textContent).toContain('Импорт отменён'));expect(api.upload).toHaveBeenCalledOnce();
});
it('reload restores a READY import by UUID without reselecting or uploading the weights',async()=>{
    const principal=durableJournalOwner({id:1,email:h.email,activeRole:h.role},base.defaults.baseURL||window.location.origin);
    localStorage.setItem('neurocenter:gguf-import:v1:'+encodeURIComponent(principal),JSON.stringify({version:1,requestKey:key}));vi.mocked(api.lookup).mockResolvedValue(receipt('READY'));
    await render();await eventually(()=>expect(document.body.textContent).toContain('GGUF проверен сервером'));expect(document.querySelector('input[type=file]')).toBeNull();expect(api.upload).not.toHaveBeenCalled();expect(button('Добавить модель в каталог').disabled).toBe(false);
});
it('new import after an accepted reload clears the accepted record and offers a fresh File selection',async()=>{
    const principal=durableJournalOwner({id:1,email:h.email,activeRole:h.role},base.defaults.baseURL||window.location.origin);
    localStorage.setItem('neurocenter:gguf-import:v1:'+encodeURIComponent(principal),JSON.stringify({version:1,requestKey:key}));vi.mocked(api.lookup).mockResolvedValue(receipt('ACCEPTED'));
    await render();await eventually(()=>expect(document.body.textContent).toContain('Модель добавлена в каталог'));await eventually(()=>expect(button('Новый импорт').disabled).toBe(false));await click('Новый импорт');
    expect(document.querySelector('input[type=file]')).not.toBeNull();expect(document.body.textContent).not.toContain('Модель добавлена в каталог');expect(document.body.textContent).not.toContain(key);
    await choose('fresh.gguf');expect(document.body.textContent).toContain('fresh.gguf');expect(button('Загрузить и проверить').disabled).toBe(false);
});
it('a late upload ACK is fenced after grants change; the same principal keeps its original receipt',async()=>{
    let resolve!:(value:unknown)=>void;vi.mocked(api.upload).mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));await render();await eventually(()=>expect(button('Выбрать файл GGUF').disabled).toBe(false));await choose();await click('Загрузить и проверить');await eventually(()=>expect(resolve).toBeDefined());
    vi.mocked(api.lookup).mockResolvedValue(receipt());h.scope='alice-grants2';await render();await eventually(()=>expect(document.body.textContent).toContain('Для продолжения выберите owned.gguf'));
    await act(async()=>resolve(receipt('READY')));expect(document.body.textContent).not.toContain('GGUF проверен сервером');expect(document.body.textContent).toContain(key);expect(api.upload).toHaveBeenCalledOnce();
    h.email='bob@example.test';h.scope='bob';await render();await eventually(()=>expect(document.body.textContent).not.toContain(key));expect(onImported).not.toHaveBeenCalled();
});
it('corrupt journal is visible and retained, and current limits failure blocks a new upload without losing selection',async()=>{
    vi.mocked(api.limits).mockRejectedValueOnce(Error('Limits unavailable'));await render();await eventually(()=>expect(document.body.textContent).toContain('Limits unavailable'));await choose();expect(button('Загрузить и проверить').disabled).toBe(true);expect(document.body.textContent).toContain('owned.gguf');
    await click('Проверить лимиты');await eventually(()=>expect(button('Загрузить и проверить').disabled).toBe(false));
    const principal=durableJournalOwner({id:1,email:h.email,activeRole:h.role},base.defaults.baseURL||window.location.origin),journal='neurocenter:gguf-import:v1:'+encodeURIComponent(principal);
    localStorage.setItem(journal,'{broken');h.scope='alice-grants3';await render();await eventually(()=>expect(document.body.textContent).toContain('Сохранённый номер импорта повреждён'));expect(localStorage.getItem(journal)).toBe('{broken');expect(button('Выбрать файл GGUF').disabled).toBe(true);expect(api.create).not.toHaveBeenCalled();
});
