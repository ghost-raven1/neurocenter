import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {BridgeSourcePanel} from '../src/features/McpBridge/BridgeSourcePanel';
import {BridgeInstallerCommand} from '../src/features/McpBridge/BridgeInstallerCommand';
import {BridgeSetup} from '../src/modules/Start/BridgeSetup';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys,type IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import api from '../src/core/api/base';

vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn()}}));
vi.mock('../src/features/McpBridge/useBridgeSource',()=>({useBridgeSource:()=>({data:undefined,error:'Каталог недоступен',loading:false,saving:false,reload:vi.fn(),check:vi.fn(),save:vi.fn()})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport',()=>({useBridgeSourceImport:()=>({blocked:false,busy:false,error:'',start:vi.fn()})}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/features/McpBridge/PairingCode',()=>({PairingCode:()=>null}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn(),location:{pathname:'/start',search:''}})}));
const io=vi.hoisted(()=>({device:undefined as IBridgeDevice|undefined}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>({device:io.device,devices:[io.device],devicesReady:true,jobsReady:true,installationsReady:true,jobs:[],installations:[],loading:false,errors:{devices:'',jobs:'',installations:''},reload:vi.fn()})}));
const installer={origin:'https://gateway.test',loading:false,error:'',reload:vi.fn(),devSupply:{version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64']}};
function render(children:ReactNode,enabled:boolean){const data={flags:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),configured:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))}as IEvaluatedFeatureFlags;return renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:vi.fn()}},children));}
beforeEach(()=>{vi.clearAllMocks();io.device={id:'own',name:'Own',role:'Разработчик',fingerprint:'',online:true,lastSeen:'2026-10-22T00:00:00Z',report:{platform:'darwin',arch:'arm64',protocolVersion:2,bridgeVersion:'0.9.18',buildId:'b'.repeat(64),capabilities:['durable-completions','managed-installations','install-set-v1','workspace-instance-v1']}};});
describe('Флаги отделяют новые managed действия от чтения и восстановления моста',()=>{
    it('OFF не подменяет dev-поставку каталогом и сохраняет публичный download без managed API',()=>{
        const html=render(createElement(BridgeSourcePanel,{installer,device:io.device,verified:true,windows:false,canManage:false,onInstall:vi.fn()}),false);expect(html).toContain('Dev-поставка: 0.9.18');expect(html).toContain('https://gateway.test/api/bridge/install.sh');expect(html).toContain('Каталог недоступен');expect(api.get).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();
    });
    it('OFF сохраняет ручную команду обновления существующей установки как recovery, не выдавая её за успех установки',()=>{
        const html=render(createElement(BridgeInstallerCommand,{installer,windows:false,target:'darwin-arm64',onCopy:vi.fn()}),false);expect(html).toContain('Копировать команду');expect(html).toContain('/api/bridge/install.sh');expect(html).not.toContain('Установка завершена');expect(api.post).not.toHaveBeenCalled();
    });
    it('Тот же настоящий BridgeSetup блокирует managed привязку папки при OFF и разрешает при ON',()=>{
        const setup=createElement(BridgeSetup,{installer,origin:'https://panel.test',windows:false,onCopy:vi.fn()});
        const button=(html:string)=>[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match=>match[2].includes('Выбрать папку проектов'));
        expect(button(render(setup,false))?.[1]).toContain('disabled');expect(button(render(setup,true))?.[1]).not.toContain('disabled');expect(api.post).not.toHaveBeenCalled();
    });
});
