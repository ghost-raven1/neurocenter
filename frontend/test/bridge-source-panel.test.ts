import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeSourcePanel, bridgeSupplyStatus } from '../src/features/McpBridge/BridgeSourcePanel';
import { bridgeDeviceTarget, bridgeSourceApi, bridgeSourceUrl, compareBridgeVersions, readBridgeSourceImport, type IBridgeSource, type IBridgeSourceRelease } from '../src/features/McpBridge/bridgeSource';
import type { IBridgeDevice } from '../src/features/McpBridge/api';
import api from '../src/core/api/base';

const fixture = vi.hoisted(() => ({ data: undefined as IBridgeSource | undefined, error: '', loading: false, saving: false,
    check: vi.fn(), reload: vi.fn(), save: vi.fn(), start: vi.fn(), install: vi.fn(), blocked: false }));
vi.mock('../src/core/api/base', () => ({default:{get:vi.fn(),post:vi.fn(),put:vi.fn()}}));
vi.mock('../src/features/McpBridge/useBridgeSource', () => ({useBridgeSource:()=>({...fixture})}));
vi.mock('../src/features/McpBridge/useBridgeSourceImport', () => ({useBridgeSourceImport:()=>({blocked:fixture.blocked,busy:false,error:'',start:fixture.start})}));

const release: IBridgeSourceRelease = {assetId:'neurocenter-bridge',version:'0.10.0',buildId:'b'.repeat(64),repositoryCommit:'c'.repeat(40),targets:['darwin-arm64','windows-x64','linux-x64']};
const source: IBridgeSource = {url:'https://github.com/example/neurocenter-assets',revision:2,checkedAt:'2026-10-21T03:00:00.000Z',available:release,imported:{...release,version:'0.9.10',buildId:'a'.repeat(64)}};
const device: IBridgeDevice = {id:'computer',name:'Computer',role:'Разработчик',fingerprint:'',online:true,lastSeen:'2026-10-21T03:00:00.000Z',report:{platform:'darwin',arch:'arm64',bridgeVersion:'0.9.5',buildId:'d'.repeat(64)}};
function render(overrides:Partial<Parameters<typeof BridgeSourcePanel>[0]>={}) {
    return renderToStaticMarkup(createElement(BridgeSourcePanel,{installer:{origin:'https://gateway.example.test:9443',loading:false,error:'',reload:vi.fn()},device,verified:true,windows:false,canManage:true,onInstall:fixture.install,...overrides}));
}
beforeEach(()=>{vi.clearAllMocks();fixture.data=structuredClone(source);fixture.error='';fixture.loading=false;fixture.saving=false;fixture.blocked=false;});

describe('Версии и установщик на шаге компьютера',()=>{
    it('Различает установленную, найденную и подготовленную версии и показывает дату проверки',()=>{
        const html=render();expect(html).toContain('Установлено: 0.9.5');expect(html).toContain('В источнике: 0.10.0');expect(html).toContain('Готово к установке: 0.9.10');expect(html).toContain('Проверено:');
        expect(html).toContain('Подготовить 0.10.0 к установке');expect(html).toContain('Обновить мост');expect(fixture.start).not.toHaveBeenCalled();expect(fixture.install).not.toHaveBeenCalled();
    });
    it.each([false,true])('Ссылка установщика использует Gateway windows=%s',windows=>{
        const html=render({windows});expect(html).toContain(`href="https://gateway.example.test:9443/api/bridge/install.${windows?'ps1':'sh'}"`);expect(html).not.toContain('localhost:5173');
    });
    it('До импорта показывает новую версию и подготовку, но не обещает готовый установщик',()=>{
        fixture.data!.imported=undefined;const html=render({device:undefined});expect(html).toContain('поставка ещё не подготовлена');expect(html).not.toContain('href="https://gateway.example.test:9443/api/bridge/install.sh"');expect(html).toContain('Подготовить 0.10.0');
    });
    it('Обычный участник видит версии и установщик; источник и импорт доступны главному админу',()=>{
        const html=render({canManage:false});expect(html).toContain('Установщик моста');expect(html).toContain('главный администратор');expect(html).not.toContain('Источник версий моста');expect(html).not.toContain('Подготовить 0.10.0');
    });
    it('Сбой источника оставляет текущий установщик, помечает снимок и не предлагает импорт',()=>{
        fixture.data!.error='GitHub не отвечает';const html=render();expect(html).toContain('GitHub не отвечает');expect(html).toContain('сохранённые данные');expect(html).toContain('Установщик моста');expect(html).not.toContain('Подготовить 0.10.0');
    });
    it('Сбой до первой подготовки не обещает существующий установщик',()=>{
        fixture.data!.imported=undefined;fixture.error='Нет связи';const html=render();expect(html).toContain('станет доступен после подготовки');expect(html).not.toContain('остаётся доступен');
    });
    it('Непроверенное или offline-подключение обозначает версию как последний отчёт',()=>{
        expect(render({verified:false})).toContain('Последний отчёт: 0.9.5');expect(render({device:{...device,online:false}})).toContain('Последний отчёт: 0.9.5');
        expect(render({device:{...device,report:{}}})).toContain('версия пока неизвестна');
    });
    it('Не предлагает понижение компьютера или неподдерживаемую платформу',()=>{
        const newer=render({device:{...device,report:{...device.report,bridgeVersion:'1.0.0'}}});expect(newer).toContain('Понижение не предлагается');expect(newer).not.toContain('Обновить мост');expect(newer).not.toContain('Показать команду установки');
        const unsupported=render({device:{...device,report:{platform:'darwin',arch:'x64'}}});expect(unsupported).toContain('нет пакета');expect(unsupported).not.toContain('Обновить мост');
    });
    it('Одинаковая версия с другим buildId требует разбора конфликта',()=>{
        fixture.data!.available={...fixture.data!.imported!,buildId:'e'.repeat(64)};const html=render();expect(html).toContain('У одной версии разные комплекты');expect(html).not.toContain('Подготовить 0.9.10');
    });
    it('Не считает несовпадающий комплект компьютера подтверждённой текущей установкой',()=>{
        const html=render({device:{...device,report:{...device.report,bridgeVersion:'0.9.10'}}});expect(html).toContain('комплект отличается');expect(html).not.toContain('Показать команду установки');
    });
});

describe('Контракт источника моста',()=>{
    it.each(['https://github.com/owner/assets',' https://github.com/owner/assets.git/ '])('Нормализует публичный корень %s',url=>{expect(bridgeSourceUrl(url)).toBe('https://github.com/owner/assets');});
    it.each(['https://github.com/owner/assets/blob/main/install.sh','https://owner:secret@github.com/owner/assets','https://github.com/owner/assets?token=secret','https://github.com/owner/assets#readme','http://github.com/owner/assets','https://gitlab.com/owner/assets','https://github.com:8443/owner/assets','https://github.com/owner/assets/../secret','https://github.com/owner/assets/%2e%2e/secret','https://github.com/owner/assets\\..\\secret'])('Не отправляет неподходящий источник %s',url=>{expect(()=>bridgeSourceUrl(url)).toThrow();});
    it.each([['0.9.10','0.10.0',-1],['0.10.0','0.9.10',1],['1.0.0','1.0.0',0],[undefined,'0.9.5',undefined],['unknown','0.9.5',undefined],['0.9.5-beta.1','0.9.5',undefined]])('Сравнивает %s с %s численно', (left,right,result)=>{expect(compareBridgeVersions(left as string|undefined,right as string)).toBe(result);});
    it('Различает готовую, новую, пониженную и конфликтующую поставку',()=>{
        expect(bridgeSupplyStatus(release,release)).toBe('ready');expect(bridgeSupplyStatus(release)).toBe('available');expect(bridgeSupplyStatus({...release,version:'0.9.0'},release)).toBe('older');expect(bridgeSupplyStatus({...release,buildId:'f'.repeat(64)},release)).toBe('conflict');
    });
    it.each([['win32','x64',undefined,'windows-x64'],['linux','x64','linux-x64-glibc','linux-x64'],['linux','x64','linux-x64-musl','linux-x64-musl'],['darwin','arm64',undefined,'darwin-arm64']])('Сопоставляет платформу %s %s с поставкой моста',(platform,arch,runtimeArtifactTarget,target)=>{expect(bridgeDeviceTarget({...device,report:{platform,arch,runtimeArtifactTarget}})).toBe(target);});
    it('Автопроверка не форсирует GitHub, а явная проверка передаёт force',async()=>{
        vi.mocked(api.post).mockResolvedValue({data:source});const signal=new AbortController().signal;
        await bridgeSourceApi.check(2,signal);await bridgeSourceApi.check(2,signal,true);
        expect(api.post).toHaveBeenNthCalledWith(1,'/api/bridge-source/check',{expectedRevision:2},{signal,timeout:65000});
        expect(api.post).toHaveBeenNthCalledWith(2,'/api/bridge-source/check',{expectedRevision:2,force:true},{signal,timeout:65000});
    });
    it('Импорт отправляет commit репозитория поставок и точный UUID, без jobId в POST',async()=>{
        vi.mocked(api.post).mockResolvedValue({data:{}});const intent={expectedRevision:2,commit:'c'.repeat(40),assetId:'bridge',requestKey:'00000000-0000-4000-8000-000000000000',jobId:'00000000-0000-4000-8000-000000000001'};
        await bridgeSourceApi.import(intent);expect(api.post).toHaveBeenCalledWith('/api/bridge-source/import',expect.objectContaining({commit:intent.commit,requestKey:intent.requestKey,expectedRevision:2}),{timeout:65000});expect(vi.mocked(api.post).mock.calls[0][1]).not.toHaveProperty('jobId');
        expect(readBridgeSourceImport(JSON.stringify(intent))).toEqual(intent);expect(readBridgeSourceImport(JSON.stringify({...intent,expectedRevision:-1}))).toBeUndefined();
    });
    it('Принятие другого источника использует точный digest просмотренного плана',async()=>{
        vi.mocked(api.post).mockResolvedValue({data:{}});await bridgeSourceApi.resolve('job-a','d'.repeat(64));
        expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/asset-imports/job-a/resolve',{expectedDigest:'d'.repeat(64)},{timeout:15000});
    });
});
