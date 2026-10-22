import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSourcePanel} from '../src/features/McpBridge/BridgeSourcePanel';
import type {IBridgeSource} from '../src/features/McpBridge/bridgeSource';

const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];return{
    begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
    state<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(value:T|((previous:T)=>T))=>{slot.value=typeof value==='function'?(value as (previous:T)=>T)(slot.value as T):value;}];},
    ref<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
    effect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,old=slots[index];if(old?.deps&&deps.length===old.deps.length&&deps.every((value,i)=>Object.is(value,old.deps![i])))return;const slot:(typeof slots)[number]=slots[index]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});},
};});
interface Button{children?:ReactNode;disabled?:boolean;onClick?:()=>void}
const ui=vi.hoisted(()=>({owner:'a',data:undefined as IBridgeSource|undefined,error:'',buttons:new Map<string,Button>(),select:undefined as ((value:string)=>void)|undefined,
    input:undefined as ((event:{target:{value:string}})=>void)|undefined,refresh:vi.fn(),sourceReload:vi.fn(),copy:vi.fn(),fetch:vi.fn(),
    captureOwner:()=>{const owner=ui.owner;return()=>owner===ui.owner;},
}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useEffect:hooks.effect,useRef:hooks.ref}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:ui.owner,captureOwner:ui.captureOwner})}));
vi.mock('../src/features/McpBridge/useBridgeSource',()=>({useBridgeSource:()=>({data:ui.data,error:ui.error,loading:false,saving:false,reload:ui.sourceReload,check:vi.fn(),save:vi.fn()})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport',()=>({useBridgeSourceImport:()=>({blocked:false,busy:false,error:'',start:vi.fn()})}));
vi.mock('antd',()=>{const content=({children}:{children?:ReactNode})=>children;return{
    Button:(props:Button)=>{ui.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);},Space:content,
    Typography:{Text:content,Paragraph:content,Title:content,Link:({children,...props}:{children?:ReactNode;href?:string})=>createElement('a',props,children)},
    Input:({onChange,...props}:{onChange:typeof ui.input;placeholder?:string})=>{ui.input=onChange;return createElement('input',{...props,onChange:()=>undefined});},
    Select:({onChange,...props}:{onChange:typeof ui.select;options?:Array<{value:string;label:string}>})=>{ui.select=onChange;return createElement('select',null,props.options?.map(value=>createElement('option',{key:value.value,value:value.value},value.label)));},
    Modal:({open,children}:{open:boolean;children?:ReactNode})=>open?createElement('section',{'aria-label':'Установка из архива'},children):null,
    Alert:({message,description,action}:{message?:ReactNode;description?:ReactNode;action?:ReactNode})=>createElement('div',null,message,description,action),Collapse:Object.assign(content,{Panel:content}),Spin:()=>null,
};});
const supply={version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64','linux-x64-musl']};
let installer={origin:'https://gateway.test' as string|undefined,devSupply:supply as typeof supply|undefined,loading:false,error:'',reload:ui.refresh};
function render(windows=false){hooks.begin();ui.buttons.clear();const html=renderToStaticMarkup(createElement(BridgeSourcePanel,{installer,verified:false,windows,canManage:false,onInstall:vi.fn()}));hooks.commit();return html;}
function open(windows=false){render(windows);expect(ui.buttons.has('Из локального архива')).toBe(true);ui.buttons.get('Из локального архива')!.onClick!();return render(windows);}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();ui.fetch.mockReset();ui.owner='a';ui.data=undefined;ui.error='';ui.select=undefined;ui.input=undefined;installer={origin:'https://gateway.test',devSupply:supply,loading:false,error:'',reload:ui.refresh};vi.stubGlobal('fetch',ui.fetch);});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();vi.useRealTimers();});
const metadata=(overrides:Record<string,unknown>={})=>({version:supply.version,buildId:supply.buildId,target:'linux-x64-musl',sha256:'c'.repeat(64),bytes:12345,...overrides});
const response=(value:unknown)=>({ok:true,json:async()=>value});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
async function choose(target='linux-x64-musl'){ui.select!(target);render();await flush();return render();}

describe('Локальный архив — самостоятельный способ установки',()=>{
    it('Отказ config и каталога не скрывает автономные инструкции и локальную команду без curl/подключения',()=>{
        installer={...installer,origin:undefined,devSupply:undefined,error:'Gateway недоступен'};ui.error='Каталог недоступен';const html=open();expect(html).toContain('без подключения к серверу');expect(html).toContain('три файла');expect(ui.fetch).not.toHaveBeenCalled();
        ui.input!({target:{value:'./мост команды.tgz'}});const ready=render();expect(ready).toContain('bash ./install.sh --archive');expect(ready).not.toContain('curl -fsSL');expect(ready).not.toContain('--connect');expect(ready).not.toContain('/api/bridge/runtime/');
    });
    it('Dev-поставка при отказе ассетов требует явный полный target и точную metadata перед тремя ссылками',async()=>{
        ui.error='Каталог недоступен';let html=open();expect(html).toContain('linux-x64-musl');expect(html).not.toContain('/api/bridge/runtime/');expect(ui.fetch).not.toHaveBeenCalled();
        ui.fetch.mockResolvedValue({ok:true,json:async()=>({version:supply.version,buildId:supply.buildId,target:'linux-x64-musl',sha256:'c'.repeat(64),bytes:12345})});ui.select!('linux-x64-musl');render();await flush();html=render();
        expect(ui.fetch).toHaveBeenCalledExactlyOnceWith('https://gateway.test/api/bridge/runtime/neurocenter-asset-sync-linux-x64-musl-0.9.18.tgz.json',expect.objectContaining({credentials:'omit',signal:expect.any(AbortSignal)}));
        expect(html).toContain('href="https://gateway.test/api/bridge/runtime/neurocenter-asset-sync-linux-x64-musl-0.9.18.tgz?download=1"');expect(html).toContain('href="https://gateway.test/api/bridge/runtime/neurocenter-asset-sync-linux-x64-musl-0.9.18.tgz.sha256?download=1"');expect(html).toContain('href="https://gateway.test/api/bridge/install.sh?version=0.9.18&amp;download=1"');expect(html).toContain('target="_blank" rel="noopener noreferrer"');expect(html).toContain('c'.repeat(64));expect(html).toContain('12345');expect(html).not.toContain('скачивание проверено');
    });
    it('Производственная imported-поставка предлагает свои точные платформы без dev-данных',async()=>{
        installer={...installer,devSupply:undefined};ui.data={url:'https://github.com/team/assets',revision:1,imported:{...supply,assetId:'bridge',repositoryCommit:'a'.repeat(40)}};open();ui.fetch.mockResolvedValue(response(metadata()));
        expect(await choose()).toContain('Скачать архив');expect(ui.fetch).toHaveBeenCalledOnce();
    });
    it('Ошибка metadata оставляет имя доставленного файла и повтор; позднее success открывает три ссылки',async()=>{
        ui.fetch.mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce(response(metadata()));open();ui.input!({target:{value:'./сохранённый мост.tgz'}});render();await choose();
        let html=render();expect(html).toContain('Не удалось подтвердить выбранный архив');expect(html).toContain('сохранённый мост.tgz');expect(html).not.toContain('Скачать архив');
        ui.buttons.get('Повторить загрузку архива')!.onClick!();render();await flush();html=render();expect(html).toContain('Скачать архив');expect(html).toContain('сохранённый мост.tgz');expect(ui.fetch).toHaveBeenCalledTimes(2);
    });
    it('Чужой build в ответе не публикует архив или installer links выбранного поколения',async()=>{
        ui.fetch.mockResolvedValue(response(metadata({buildId:'a'.repeat(64)})));open();const html=await choose();expect(html).not.toContain('Скачать архив');expect(html).not.toContain('install.sh?version=');expect(html).toContain('Не удалось подтвердить выбранный архив');
    });
    it('Явный Windows target выбирает PowerShell для другого компьютера и копирует независимый literal',async()=>{
        installer={...installer,devSupply:{...supply,targets:['windows-x64']}};ui.fetch.mockResolvedValue(response(metadata({target:'windows-x64'})));vi.stubGlobal('navigator',{clipboard:{writeText:ui.copy}});
        open(false);let html=await choose('windows-x64');expect(html).toContain('href="https://gateway.test/api/bridge/install.ps1?version=0.9.18&amp;download=1"');expect(html).not.toContain('install.sh?version=');
        ui.input!({target:{value:"C:\\Files\\team's bridge.tgz"}});html=render();expect(html).toContain('-Archive');ui.buttons.get('Копировать локальную команду')!.onClick!();await flush();expect(ui.copy).toHaveBeenCalledExactlyOnceWith("& .\\install.ps1 -Archive 'C:\\Files\\team''s bridge.tgz'");
    });
    it('Смена поколения очищает старые ссылки и не принимает поздний JSON прежнего build',async()=>{
        const old=deferred<unknown>();ui.fetch.mockResolvedValueOnce({ok:true,json:()=>old.promise}).mockResolvedValueOnce(response(metadata({buildId:'d'.repeat(64),sha256:'e'.repeat(64)})));open();await choose();
        installer={...installer,devSupply:{...supply,buildId:'d'.repeat(64)}};expect(render()).not.toContain('Скачать архив');await flush();let html=render();expect(html).toContain('e'.repeat(64));old.resolve(metadata());await flush();html=render();expect(html).toContain('e'.repeat(64));expect(html).not.toContain('c'.repeat(64));
    });
    it('Смена Gateway маскирует прежний результат до ответа нового сервера',async()=>{
        const next=deferred<unknown>();ui.fetch.mockResolvedValueOnce(response(metadata())).mockReturnValueOnce(next.promise);open();expect(await choose()).toContain('Скачать архив');
        installer={...installer,origin:'https://next-gateway.test'};expect(render()).not.toContain('Скачать архив');next.resolve(response(metadata()));await flush();const html=render();expect(html).toContain('href="https://next-gateway.test/api/bridge/runtime/');expect(html).not.toContain('href="https://gateway.test/api/bridge/runtime/');
    });
    it('Смена владельца не переносит локальный путь, выбранную платформу или поздние metadata',async()=>{
        const pending=deferred<unknown>();ui.fetch.mockReturnValue(pending.promise);open();ui.input!({target:{value:'./private-a.tgz'}});expect(render()).toContain('private-a.tgz');await choose();const signal=ui.fetch.mock.calls[0][1].signal as AbortSignal;
        ui.owner='b';let html=render();expect(signal.aborted).toBe(true);expect(html).not.toContain('private-a.tgz');expect(html).not.toContain('Скачать архив');pending.resolve(response(metadata()));await flush();html=render();expect(html).not.toContain('Скачать архив');expect(ui.fetch).toHaveBeenCalledOnce();
    });
    it('Закрытие формы прерывает metadata request, поздний ответ не появляется в новом окне',async()=>{
        const pending=deferred<unknown>();ui.fetch.mockReturnValue(pending.promise);open();await choose();const signal=ui.fetch.mock.calls[0][1].signal as AbortSignal;hooks.dispose();expect(signal.aborted).toBe(true);pending.resolve(response(metadata()));await flush();expect(open()).not.toContain('Скачать архив');
    });
    it('Зависший публичный запрос ограничен десятью секундами, затем есть явный повтор',async()=>{
        vi.useFakeTimers();ui.fetch.mockImplementation((_url:string,{signal}:{signal:AbortSignal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));open();await choose();await vi.advanceTimersByTimeAsync(10000);await flush();const html=render();expect(html).toContain('Не удалось подтвердить выбранный архив');expect(ui.buttons.has('Повторить загрузку архива')).toBe(true);expect(html).not.toContain('Скачать архив');
    });
    it('Недопустимое имя объясняет отказ копирования, после исправления локальная команда снова доступна',()=>{
        installer={...installer,origin:undefined,devSupply:undefined};open();ui.input!({target:{value:'file\nname.tgz'}});expect(render()).toContain('без управляющих символов');expect(ui.buttons.has('Копировать локальную команду')).toBe(false);
        ui.input!({target:{value:'./my bridge.tgz'}});expect(render()).toContain('Копировать локальную команду');expect(ui.fetch).not.toHaveBeenCalled();
    });
    it('Отказ clipboard оставляет выделяемую команду и ручное копирование без ложного успеха установки',async()=>{
        installer={...installer,origin:undefined,devSupply:undefined};vi.stubGlobal('navigator',{clipboard:{writeText:ui.copy.mockRejectedValueOnce(Error('denied'))}});open();ui.input!({target:{value:'./bridge.tgz'}});render();ui.buttons.get('Копировать локальную команду')!.onClick!();await flush();
        const html=render();expect(html).toContain('Выделите команду');expect(html).toContain('bash ./install.sh --archive');expect(html).not.toContain('Установка завершена');expect(ui.fetch).not.toHaveBeenCalled();
        ui.buttons.get('Копировать локальную команду')!.onClick!();await flush();expect(render()).not.toContain('Не удалось скопировать');expect(ui.copy).toHaveBeenCalledTimes(2);
    });
});
