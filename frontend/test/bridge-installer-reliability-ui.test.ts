import './feature-flags-enabled';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeInstallerCommand} from '../src/features/McpBridge/BridgeInstallerCommand';
import {BridgeSetup} from '../src/modules/Start/BridgeSetup';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import type {useBridge} from '../src/features/McpBridge/useBridge';

const hooks=vi.hoisted(()=>{let cursor=0;const slots:unknown[]=[];return{begin:()=>{cursor=0;},dispose:()=>{slots.length=0;},useState<T>(initial:T){const index=cursor++;if(index>=slots.length)slots[index]=initial;return[slots[index],(next:T)=>{slots[index]=next;}];}};});
const io=vi.hoisted(()=>({bridge:undefined as unknown as ReturnType<typeof useBridge>,search:'',changeAction:undefined as undefined|((event:{target:{value:string}})=>void)}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>io.bridge}));
vi.mock('../src/features/McpBridge/BridgeSourcePanel',()=>({BridgeSourcePanel:()=>null}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/features/McpBridge/PairingCode',()=>({PairingCode:()=>null}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn(),location:{pathname:'/start',search:io.search}})}));
vi.mock('antd',async original=>{const actual=await original<typeof import('antd')>();return{...actual,Radio:{...actual.Radio,Group:(props:Parameters<typeof actual.Radio.Group>[0])=>{io.changeAction=props.onChange;return createElement(actual.Radio.Group,props);}}};});
const installer={origin:'https://gateway.test',loading:false,error:'',reload:vi.fn(),devSupply:{version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64']}};
const copy=vi.fn();
const device:IBridgeDevice={id:'own',name:'Own',role:'Разработчик',fingerprint:'',online:true,lastSeen:'2026-10-22T00:00:00Z',report:{platform:'darwin',arch:'x64',bridgeVersion:'0.9.17',protocolVersion:2,capabilities:[]}};
function setup(){hooks.begin();return renderToStaticMarkup(createElement(BridgeSetup,{installer,origin:'https://panel.test',windows:false,onCopy:copy}));}
beforeEach(()=>{vi.clearAllMocks();hooks.dispose();io.search='';io.changeAction=undefined;io.bridge={device,devices:[device],devicesReady:true,jobsReady:true,installationsReady:true,jobs:[],installations:[],loading:false,error:'',errors:{devices:'',jobs:'',installations:''},choose:vi.fn(),reload:vi.fn()};});
describe('Совместимость dev-поставки во всех входах мастера',()=>{
    it('Прямая команда не выдаёт PowerShell для dev-поставки без Windows-пакета',()=>{
        const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer,windows:true,onCopy:copy}));expect(html).not.toContain('/install.ps1');expect(html).not.toContain('Копировать команду');expect(html).toContain('нет пакета');expect(copy).not.toHaveBeenCalled();
    });
    it('OpenCode-вход также не обещает отсутствующий Windows runtime моста',()=>{
        const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer,windows:true,openCode:true,onCopy:copy}));expect(html).not.toContain('/install_opencode.ps1');expect(html).toContain('нет пакета');
    });
    it('Настоящий BridgeSetup не обходит точную платформу через автоматический переход к установке',()=>{
        const html=setup();expect(html).toContain('Обновите мост');expect(html).not.toContain('/api/bridge/install.sh');expect(html).toContain('нет пакета');
    });
    it('Ручной переход Radio к установке также повторяет точный target guard выбранного устройства',()=>{
        io.search='?addComputer=1';io.bridge.device={...device,report:{...device.report,capabilities:['durable-completions','managed-installations','install-set-v1','workspace-instance-v1']}};
        expect(setup()).toContain('connect --open');expect(io.changeAction).toBeDefined();io.changeAction!({target:{value:'install'}});const html=setup();expect(html).not.toContain('/api/bridge/install.sh');expect(html).toContain('нет пакета');expect(copy).not.toHaveBeenCalled();
    });
    it('Неизвестная архитектура POSIX оставляет проверку установщику, без обещания совместимости',()=>{
        const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer,windows:false,onCopy:copy}));expect(html).toContain('/api/bridge/install.sh');expect(html).toContain('Архитектуру компьютера проверит установщик');expect(html).not.toContain('Установлено');
    });
    it('Первый вход без устройств по-прежнему предлагает подключить ранее установленный мост',()=>{
        io.bridge.devices=[];io.bridge.device=undefined;const html=setup();expect(html).toContain('Мост уже установлен');expect(html).toContain('connect --open');expect(html).not.toContain('/api/bridge/install.sh');
    });
    it('Production-команда без dev metadata сохраняет прежний выбор Windows',()=>{
        const html=renderToStaticMarkup(createElement(BridgeInstallerCommand,{installer:{...installer,devSupply:undefined},windows:true,onCopy:copy}));expect(html).toContain('/api/bridge/install.ps1');expect(html).toContain('Копировать команду');
    });
});
