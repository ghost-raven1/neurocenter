import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSourcePanel} from '../src/features/McpBridge/BridgeSourcePanel';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import type {IBridgeSource} from '../src/features/McpBridge/bridgeSource';

interface ButtonProps {children?:ReactNode;disabled?:boolean;onClick?:()=>void}
const io=vi.hoisted(()=>({data:undefined as IBridgeSource|undefined,error:'',buttons:new Map<string,ButtonProps>(),install:vi.fn(),start:vi.fn(),reload:vi.fn()}));
vi.mock('../src/features/McpBridge/useBridgeSource',()=>({useBridgeSource:()=>({data:io.data,error:io.error,loading:false,saving:false,reload:io.reload,check:vi.fn(),save:vi.fn()})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport',()=>({useBridgeSourceImport:()=>({blocked:false,busy:false,error:'',start:io.start})}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return{Button:(props:ButtonProps)=>{io.buttons.set(String(props.children),props);return createElement('button',{disabled:props.disabled},props.children);},Space:content,
        Typography:{Text:content,Paragraph:content,Link:({children,href}:{children?:ReactNode;href?:string})=>createElement('a',{href},children)},Input:()=>null,Modal:()=>null,
        Alert:({message,description}:{message?:ReactNode;description?:ReactNode})=>createElement('div',null,message,description),Collapse:Object.assign(content,{Panel:content})};
});
const supply={version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64']};
const installer={origin:'https://gateway.test',devSupply:supply,loading:false,error:'',reload:vi.fn()};
const device:IBridgeDevice={id:'own',name:'Own',role:'Разработчик',fingerprint:'',online:true,lastSeen:'2026-10-22T00:00:00Z',report:{platform:'darwin',arch:'arm64',bridgeVersion:'0.9.17',buildId:'a'.repeat(64)}};
const catalog:IBridgeSource={url:'https://github.com/catalog/assets',revision:3,available:{assetId:'bridge',version:'0.10.0',buildId:'c'.repeat(64),repositoryCommit:'d'.repeat(40),targets:['linux-x64']},imported:{assetId:'bridge',version:'0.9.10',buildId:'e'.repeat(64),repositoryCommit:'f'.repeat(40),targets:['linux-x64']}};
function render(overrides:Partial<Parameters<typeof BridgeSourcePanel>[0]>={}){io.buttons.clear();return renderToStaticMarkup(createElement(BridgeSourcePanel,{installer,device,verified:true,windows:false,canManage:true,onInstall:io.install,...overrides}));}
beforeEach(()=>{vi.clearAllMocks();io.data=undefined;io.error='';});

describe('Dev-установщик независим от доступности каталога',()=>{
    it('При отказе списка ассетов и пустом каталоге показывает dev-версию и рабочее явное обновление',()=>{
        io.error='Каталог ассетов недоступен';const html=render();expect(html).toContain('Dev-поставка: 0.9.18');expect(html).toContain('Готово к установке: 0.9.18');expect(html).toContain('href="https://gateway.test/api/bridge/install.sh"');
        expect(io.buttons.get('Обновить dev-мост')?.disabled).not.toBe(true);expect(io.buttons.has('Обновить dev-мост')).toBe(true);expect(io.install).not.toHaveBeenCalled();io.buttons.get('Обновить dev-мост')!.onClick!();expect(io.install).toHaveBeenCalledOnce();expect(io.start).not.toHaveBeenCalled();
        expect(html).toContain(io.error);expect(html).not.toContain('станет доступен после подготовки поставки');
    });
    it('Одинаковая dev-версия с новым build предлагает именно явное dev-обновление',()=>{
        const html=render({device:{...device,report:{...device.report,bridgeVersion:supply.version}}});expect(html).toContain('Обновить dev-мост');expect(html).not.toContain('Проверьте происхождение');expect(io.install).not.toHaveBeenCalled();
    });
    it('Более новая установленная версия не получает предложение dev-понижения',()=>{
        const html=render({device:{...device,report:{...device.report,bridgeVersion:'0.10.0'}}});expect(html).toContain('Понижение не предлагается');expect(io.buttons.has('Обновить dev-мост')).toBe(false);expect(io.buttons.has('Показать команду установки')).toBe(false);
    });
    it('Чужая платформа не становится готовой установкой из-за подходящего пакета в каталоге',()=>{
        io.data=structuredClone(catalog);const html=render({device:{...device,report:{...device.report,platform:'linux',arch:'x64'}}});expect(html).toContain('нет пакета');expect(io.buttons.has('Обновить dev-мост')).toBe(false);expect(html).not.toContain('href="https://gateway.test/api/bridge/install.sh"');
    });
    it('Без выбранного компьютера сохраняет существующий выбор системы и предлагает dev-установку',()=>{
        const html=render({device:undefined,windows:true});expect(html).toContain('Компьютер ещё не выбран');expect(html).toContain('Установить dev-мост');expect(html).toContain('/api/bridge/install.ps1');
    });
    it('Не меняет каталог, его найденную версию или provenance на данные dev-поставки',()=>{
        io.data=structuredClone(catalog);const before=structuredClone(io.data);const html=render();expect(html).toContain('Последняя проверка источника: 0.10.0');expect(html).toContain('В каталоге подготовлено: 0.9.10');expect(html).toContain('Готово к установке: 0.9.18');expect(io.data).toEqual(before);expect(io.start).not.toHaveBeenCalled();
    });
    it('Без dev сохраняет конфликт одинаковой версии с другим build и исходную готовую версию',()=>{
        io.data=structuredClone(catalog);const html=render({installer:{...installer,devSupply:undefined},device:{...device,report:{...device.report,platform:'linux',arch:'x64',bridgeVersion:'0.9.10'}}});expect(html).toContain('Готово к установке: 0.9.10');expect(html).toContain('Проверьте происхождение');expect(io.buttons.has('Показать команду установки')).toBe(false);expect(io.buttons.has('Обновить dev-мост')).toBe(false);
    });
    it('Та же dev-версия и тот же build оставляют обычную команду без ложного обновления',()=>{
        const html=render({device:{...device,report:{...device.report,bridgeVersion:supply.version,buildId:supply.buildId}}});expect(html).toContain('Показать команду установки');expect(io.buttons.has('Обновить dev-мост')).toBe(false);
    });
    it('Явное обновление перечитывает Gateway config и каталог даже после отказа списка ассетов',()=>{
        io.error='Каталог недоступен';render();expect(installer.reload).not.toHaveBeenCalled();io.buttons.get('Обновить локальную поставку')!.onClick!();expect(installer.reload).toHaveBeenCalledOnce();expect(io.reload).toHaveBeenCalledOnce();
    });
    it.each([{loading:true,error:''},{loading:false,error:'Некорректная dev-поставка'}])('Загрузка или ошибка config скрывает старую команду и установку: %j',state=>{
        const html=render({installer:{...installer,...state}});expect(html).not.toContain('href="https://gateway.test/api/bridge/install.sh"');expect(io.buttons.has('Обновить dev-мост')).toBe(false);expect(io.install).not.toHaveBeenCalled();
    });
});
