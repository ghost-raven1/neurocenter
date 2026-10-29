// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ProjectTextKnowledge} from '../src/features/ProjectTextKnowledge/ProjectTextKnowledge';
import RagTab from '../src/modules/Projects/components/RagTab';
import {projectTextApi as api} from '../src/features/ProjectTextKnowledge/api';
import {defaultTextKnowledgeLimits} from '../src/features/ProjectTextKnowledge/limits';
import type {TextCorpusState, TextUploadReceipt} from '../src/features/ProjectTextKnowledge/model';

const h=vi.hoisted(()=>({scope:'alice',enabled:true,role:'Главный админ',semantic:vi.fn(),captures:new Map<string,()=>()=>boolean>()}));
vi.mock('../src/features/ProjectTextKnowledge/api',()=>({projectTextApi:{limits:vi.fn(),state:vi.fn(),receipt:vi.fn(),upload:vi.fn(),search:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{
    const owner=h.scope;let capture=h.captures.get(owner);if(!capture){capture=()=>()=>owner===h.scope;h.captures.set(owner,capture);}return{scope:owner,captureOwner:capture};
}}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{email:'alice@example.test',activeRole:h.role,userRoles:[h.role],projectRoles:[]}}})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:'Текстовая база знаний выключена',loading:false,known:true,refresh:vi.fn()})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:vi.fn()}));
vi.mock('../src/modules/Projects/components/SemanticRag',()=>({default:({projectKey}:{projectKey:string})=>{h.semantic(projectKey);return createElement('div',null,'ADVANCED_INDEX');}}));
let container:HTMLDivElement,root:Root;
const state=(id='prj-a',revision=0):TextCorpusState=>({mode:'text',projectId:id,revision,corpusHash:String(revision).repeat(64),documentCount:revision,bytes:revision*32,updatedAt:null});
const render=async(id='prj-a',rag=false)=>{await act(async()=>root.render(createElement(rag?RagTab:ProjectTextKnowledge,rag?{projectKey:id}:{projectId:id})));};
const eventually=async(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await Promise.resolve();});check();},{timeout:1500,interval:5});
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)!;
const click=async(label:string)=>{expect(button(label)).toBeTruthy();await act(async()=>button(label).click());};
async function select(content:string,name='README.md') {
    const file=new File([content],name,{type:'text/plain'});Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode(content).buffer});
    const input=container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input,'files',{configurable:true,value:[file]});await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
}
async function query(value:string) {
    const input=container.querySelector<HTMLInputElement>('input:not([type=file])')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
}
beforeEach(()=>{
    vi.clearAllMocks();h.scope='alice';h.enabled=true;h.role='Главный админ';h.captures.clear();localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',{subtle:webcrypto.subtle,randomUUID:()=>webcrypto.randomUUID()});
    vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
    vi.mocked(api.limits).mockResolvedValue({revision:3,limits:defaultTextKnowledgeLimits});
    vi.mocked(api.state).mockImplementation(async id=>state(id));vi.mocked(api.receipt).mockResolvedValue(null);
    vi.mocked(api.search).mockImplementation(async id=>({...state(id,1),sources:[{id:'one',path:'README.md',startLine:2,endLine:4,excerpt:'<script>Авторизация</script>\nconst key = true;',score:0.8}]}));
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();localStorage.clear();});

it('empty text mode offers upload and search without mounting advanced tools; opening advanced is explicit',async()=>{
    await render('prj-a',true);await eventually(()=>expect(container.textContent).toContain('База пока пуста'));
    expect(button('Добавить файлы').disabled).toBe(false);expect(h.semantic).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled();expect(api.search).not.toHaveBeenCalled();
    const details=container.querySelector<HTMLDetailsElement>('.project-rag__advanced')!;
    await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle',{bubbles:true}));});
    await eventually(()=>expect(container.textContent).toContain('ADVANCED_INDEX'));expect(h.semantic).toHaveBeenCalledWith('prj-a');
});

it('a real file draft survives lost ACK, recovers the same receipt and displays escaped citation paths/lines',async()=>{
    const receipts=new Map<string,TextUploadReceipt>();let uploaded=false;
    vi.mocked(api.state).mockImplementation(async id=>state(id,uploaded?1:0));
    vi.mocked(api.upload).mockImplementation(async(id,body)=>{
        const requestHash=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)))).toString('hex');
        receipts.set(body.requestKey,{...state(id,1),requestKey:body.requestKey,requestHash,acceptedAt:'2026-10-29T12:00:00Z'});uploaded=true;throw Error('Ответ потерян');
    });
    vi.mocked(api.receipt).mockImplementation(async(_id,key)=>receipts.get(key)??null);
    await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));await select('Авторизация\nconst key = true;');
    expect(container.textContent).toContain('README.md');await click('Сохранить в базе знаний');await eventually(()=>expect(container.textContent).toContain('Загрузка принята: версия 1'));
    expect(api.upload).toHaveBeenCalledOnce();expect(api.receipt).toHaveBeenCalledWith('prj-a',vi.mocked(api.upload).mock.calls[0][1].requestKey,expect.any(AbortSignal));
    await query('Авторизация');await click('Найти');await eventually(()=>expect(container.textContent).toContain('Строки 2–4'));
    expect(container.querySelector('pre')?.textContent).toContain('<script>Авторизация</script>');expect(container.querySelector('script')).toBeNull();
    expect(api.search).toHaveBeenCalledWith('prj-a','Авторизация',1,expect.any(AbortSignal));
});

it('a failed selection and search retain existing draft/query, and empty search produces no invented citations',async()=>{
    vi.mocked(api.state).mockImplementation(async id=>state(id,1));await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));
    await select('keep file','kept.ts');await select('binary\0','bad.bin');expect(container.textContent).toContain('kept.ts');expect(container.textContent).not.toContain('Убрать bad.bin');
    await query('сохранённый запрос');vi.mocked(api.search).mockRejectedValueOnce(Error('Нет соединения'));await click('Найти');
    await eventually(()=>expect(container.textContent).toContain('Нет соединения'));expect(container.querySelector<HTMLInputElement>('input:not([type=file])')!.value).toBe('сохранённый запрос');expect(container.textContent).toContain('kept.ts');
    vi.mocked(api.search).mockResolvedValueOnce({...state('prj-a',1),sources:[]});await click('Найти');await eventually(()=>expect(container.textContent).toContain('Совпадений нет'));expect(container.querySelectorAll('article')).toHaveLength(0);
});

it('limits failure blocks new writes, preserves the draft and offers a retry; OFF leaves the corpus visible',async()=>{
    vi.mocked(api.state).mockImplementation(async id=>state(id,1));await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));await select('keep');
    vi.mocked(api.limits).mockRejectedValueOnce(Error('Лимиты недоступны'));await click('Сохранить в базе знаний');
    await eventually(()=>expect(container.textContent).toContain('Лимиты недоступны'));expect(container.textContent).toContain('README.md');expect(api.upload).not.toHaveBeenCalled();
    expect(button('Добавить файлы').disabled).toBe(true);await click('Проверить лимиты');await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));
    h.enabled=false;await render();expect(container.textContent).toContain('Файлов: 1');expect(button('Добавить файлы').disabled).toBe(true);
});

it('switching project clears its draft/query and a held old corpus response never appears in the next project',async()=>{
    await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));await select('A','only-a.md');await query('project A');
    let late!:(value:TextCorpusState)=>void;vi.mocked(api.state).mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));await click('Обновить сведения');
    await render('prj-b');await eventually(()=>expect(container.textContent).toContain('База пока пуста'));await act(async()=>late(state('prj-a',8)));
    expect(container.textContent).not.toContain('only-a.md');expect(container.textContent).not.toContain('Файлов: 8');expect(container.querySelector<HTMLInputElement>('input:not([type=file])')!.value).toBe('');
});

it('same-principal permission changes recover an accepted403 upload through the original stable journal',async()=>{
    let accepted:TextUploadReceipt|undefined,denied=true;
    vi.mocked(api.upload).mockImplementation(async(id,body)=>{
        const requestHash=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)))).toString('hex');
        accepted={...state(id,1),requestKey:body.requestKey,requestHash,acceptedAt:'2026-10-29T12:00:00Z'};throw {response:{status:403}};
    });
    vi.mocked(api.receipt).mockImplementation(async()=>{if(denied)throw {response:{status:403}};return accepted??null;});
    await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));await select('kept accepted bytes');await click('Сохранить в базе знаний');
    await eventually(()=>expect(api.receipt).toHaveBeenCalledOnce());const key=localStorage.key(0),requestKey=accepted!.requestKey;
    denied=false;h.scope='alice-with-new-project-permissions';await render();
    await eventually(()=>expect(container.textContent).toContain('Загрузка принята: версия 1'));
    expect(api.upload).toHaveBeenCalledOnce();expect(localStorage.key(0)).toBe(key);expect(vi.mocked(api.receipt).mock.calls.at(-1)?.[1]).toBe(requestKey);
});

it('late upload ACK from the previous permission scope cannot confirm the restored text journal',async()=>{
    let accepted:TextUploadReceipt|undefined,resolve!:(value:TextUploadReceipt)=>void;
    vi.mocked(api.upload).mockImplementation(async(id,body)=>{
        const requestHash=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)))).toString('hex');
        accepted={...state(id,1),requestKey:body.requestKey,requestHash,acceptedAt:'2026-10-29T12:00:00Z'};return new Promise(yes=>{resolve=yes;});
    });
    await render();await eventually(()=>expect(button('Добавить файлы').disabled).toBe(false));await select('accepted old scope');await click('Сохранить в базе знаний');
    await eventually(()=>expect(resolve).toBeDefined());h.scope='alice-main-permissions-updated';await render();
    await eventually(()=>expect(api.receipt).toHaveBeenCalledOnce());await act(async()=>{resolve(accepted!);await Promise.resolve();});
    expect(container.textContent).not.toContain('Загрузка принята: версия 1');expect(container.textContent).toContain(accepted!.requestKey);
    vi.mocked(api.receipt).mockResolvedValueOnce(accepted!);await click('Проверить загрузку');await eventually(()=>expect(container.textContent).toContain('Загрузка принята: версия 1'));
    expect(api.upload).toHaveBeenCalledOnce();
});
