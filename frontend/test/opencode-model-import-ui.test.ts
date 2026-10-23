import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeImportModal } from '../src/features/ModelCatalog/OpenCodeImportModal';
import baseApi from '../src/core/api/base';
import { bridgeApi, type IBridgeJob } from '../src/features/McpBridge/api';

const ui = vi.hoisted(() => ({
    cursor: 0, states: [] as unknown[], refs: [] as unknown[], refCursor: 0, owner: 'admin-a',
    buttons: new Map<string, { click?: () => void; disabled?: boolean }>(), imported: vi.fn(), configureCodex: vi.fn(), canConfigureCodex: true, reload: vi.fn(), job: undefined as IBridgeJob | undefined,
    selects:new Map<string,{change:(value:string)=>void;disabled:boolean}>(),projectId:'project-one' as string|undefined,
    bound:true,online:true,capabilities:['opencode-model-scan-v2'],
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const index = ui.cursor++; if (!(index in ui.states)) ui.states[index] = initial; return [ui.states[index], (value: unknown) => { ui.states[index] = value; }]; },
    useRef: (initial: unknown) => { const index = ui.refCursor++; return ui.refs[index] ??= { current: initial }; },
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const owner = ui.owner; return { captureOwner: () => () => owner === ui.owner }; } }));
vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { create: vi.fn() } }));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => ({
    devices: [{ id: 'computer-one', name: 'Компьютер', online: ui.online, report: { bindings: ui.bound?[{ projectId: 'project-one', bindingId: 'binding-one', instanceId: 'instance-one' }]:[], capabilities: ui.capabilities } }],
    jobs: ui.job ? [ui.job] : [], errors: {}, devicesReady: true, reload: ui.reload,
}) }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const List = Object.assign(({ dataSource, renderItem }: { dataSource: unknown[]; renderItem: (value: unknown) => ReactNode }) => createElement('div', null, dataSource.map((value, index) => createElement('div', { key: index }, renderItem(value)))), { Item: content });
    return { Modal: content, Space: content, Tag: content, List, Select: (props:{'aria-label':string;onChange:(value:string)=>void;disabled:boolean}) => {ui.selects.set(props['aria-label'],{change:props.onChange,disabled:props.disabled});return null;}, Spin: () => null,
        Typography: { Paragraph: content, Text: content }, Alert: ({ message, description }: { message: string; description?: string }) => createElement('div', null, message, description),
        Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => { if (typeof children === 'string') ui.buttons.set(children, { disabled, click: onClick }); return children; },
    };
});

const candidate = { candidateId: 'candidate-one', provider: 'fixture', name: 'Модель из OpenCode', model: 'fixture-chat', capability: 'chat', runtime: 'remote-openai', hasKey: true, blocker: null,
    options: { temperature: 0, topP: 0.8, maxOutputTokens: 2048 }, timeoutMs: 30000 };
const scan = (changes = {}) => ({ id: 'job-one', deviceId: 'computer-one', state: 'succeeded', result: {schemaVersion:2,scope:'project',projectId:'project-one',bindingId:'binding-one',instanceId:'instance-one', candidates: [{ ...candidate, ...changes }], warnings: [], expiresAt: '2099-01-01T00:00:00Z' } } as unknown as IBridgeJob);
function render() { ui.cursor = 0; ui.refCursor = 0; ui.buttons.clear();ui.selects.clear(); return renderToStaticMarkup(createElement(OpenCodeImportModal, { projectId: ui.projectId, onClose: vi.fn(), onImported: ui.imported, onConfigureCodex: ui.canConfigureCodex ? ui.configureCodex : undefined })); }
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
async function read(job = scan()) { vi.mocked(bridgeApi.create).mockResolvedValueOnce(job); render(); ui.buttons.get('Прочитать OpenCode')!.click!(); await flush(); return render(); }

beforeEach(() => { vi.clearAllMocks(); ui.states = []; ui.refs = []; ui.owner = 'admin-a'; ui.job = undefined;ui.projectId='project-one';ui.bound=true;ui.online=true;ui.canConfigureCodex=true;ui.capabilities=['opencode-model-scan-v2']; ui.imported.mockResolvedValue(undefined); });

describe('Импорт модели из доступной конфигурации OpenCode', () => {
    it('Показывает Responses и точную политику false до импорта',async()=>{
        const html=await read(scan({options:{apiFormat:'responses',reasoningEffort:'high',store:false}}));
        expect(html).toContain('API: Responses');expect(html).toContain('Рассуждения: high');expect(html).toContain('Хранение ответа: выключено');
    });
    it('Неизвестные параметры имеют имена/типы и явный путь ручной настройки без ложной готовности',async()=>{
        const html=await read(scan({blocker:'unsupported-provider',parameterIssues:[{name:'custom',type:'object'},{name:'enabled',type:'boolean'}]}));
        expect(html).toContain('custom (object)');expect(html).toContain('enabled (boolean)');expect(html).toContain('Значения сохранены в исходном OpenCode');expect(html).toContain('JSON параметров адаптера');expect(ui.buttons.get('Импортировать')?.disabled).toBe(true);
    });
    it.each(['codex-local-auth','device-local-endpoint','local-provider-auth'])('Точный blocker %s не предлагает небезопасный импорт',async blocker=>{
        const html=await read(scan({blocker}));expect(ui.buttons.get('Импортировать')?.disabled).toBe(true);
        expect(html).toContain(blocker==='codex-local-auth'?'Codex Bridge — локальный вход':blocker==='device-local-endpoint'?'Этот localhost относится к выбранному компьютеру':'локальная сессия не переносится');
    });
    it('Старый generic blocker CodexBridge объясняет локальный вход и передаёт выбранный компьютер без импорта', async () => {
        const html = await read(scan({provider: 'codexbridge', name: 'GPT-6.1-Sol', model: 'gpt-6.1-sol', blocker: 'unsupported-provider', parameterIssues: [{name: 'transport', type: 'object'}]}));
        expect(html).toContain('Codex Bridge — локальный вход'); expect(html).not.toContain('Провайдер или параметры не поддерживаются');
        expect(html).toContain('transport (object)'); expect(html).not.toContain('JSON параметров адаптера'); expect(html).toContain('gpt-6.1-sol');
        expect(html).toContain('Вход Codex остаётся на компьютере'); expect(html).not.toContain('Этот импорт не передаёт ключ с компьютера');
        expect(ui.buttons.get('Импортировать')?.disabled).toBe(true); expect(ui.configureCodex).not.toHaveBeenCalled();
        ui.buttons.get('Импортировать')!.click!(); await flush(); expect(baseApi.post).not.toHaveBeenCalled();
        ui.buttons.get('Настроить Codex в OpenCode')!.click!(); expect(ui.configureCodex).toHaveBeenCalledExactlyOnceWith('computer-one');
        expect(bridgeApi.create).toHaveBeenCalledTimes(1); expect(ui.imported).not.toHaveBeenCalled();
    });
    it('Общий CodexBridge требует выбрать проект и не изображает переход в локальный мастер', async () => {
        ui.projectId = undefined; const job = scan({provider: 'codexbridge', blocker: 'unsupported-provider'});
        Object.assign(job.result!, {scope: 'global', deviceId: 'computer-one', projectId: undefined, bindingId: undefined, instanceId: undefined});
        const html = await read(job); expect(html).toContain('Откройте нужный проект'); expect(ui.buttons.has('Настроить Codex в OpenCode')).toBe(false);
        expect(ui.configureCodex).not.toHaveBeenCalled(); expect(ui.buttons.get('Импортировать')?.disabled).toBe(true);
    });
    it('Смена actor отвергает старый локальный handoff, а отсутствие прав не предлагает его', async () => {
        await read(scan({provider: 'codexbridge', blocker: 'unsupported-provider'})); const action = ui.buttons.get('Настроить Codex в OpenCode')!.click!;
        ui.owner = 'admin-b'; action(); expect(ui.configureCodex).not.toHaveBeenCalled();
        ui.canConfigureCodex = false; render(); expect(ui.buttons.has('Настроить Codex в OpenCode')).toBe(false);
    });
    it('Показывает поддерживаемые параметры, явный ноль и таймаут до импорта, не обещая автоматическую синхронизацию', async () => {
        const html = await read();
        expect(html).toContain('Температура: 0'); expect(html).toContain('Top P: 0.8'); expect(html).toContain('2048 токенов'); expect(html).toContain('Ожидание ответа: 30000 мс');
        expect(html).toContain('Импорт выполняется по кнопке'); expect(html).toContain('Этот импорт не передаёт ключ с компьютера');
    });
    it('Импорт передаёт серверу только ссылку на снимок, затем переносит безопасные параметры в форму подключения', async () => {
        await read(); const model = { id: 'imported-model' };
        vi.mocked(baseApi.post).mockResolvedValueOnce({ data: { model, baseUrl: 'https://fixture.example/v1', hasKeyOnComputer: true, options: candidate.options, timeoutMs: 30000 } });
        ui.buttons.get('Импортировать')!.click!(); await flush();
        expect(baseApi.post).toHaveBeenCalledExactlyOnceWith('/api/models/import-opencode', { deviceId: 'computer-one', jobId: 'job-one', candidateId: 'candidate-one' });
        expect(ui.imported).toHaveBeenCalledExactlyOnceWith(model, { baseUrl: 'https://fixture.example/v1', hasKey: true, options: candidate.options, timeoutMs: 30000 });
    });
    it('Показывает причину блокировки неподдерживаемых параметров и не предлагает импорт', async () => {
        const html = await read(scan({ blocker: 'unsupported-provider' }));
        expect(html).toContain('Провайдер или параметры не поддерживаются'); expect(ui.buttons.get('Импортировать')?.disabled).toBe(true);
    });
    it('Истёкший снимок не предлагает импорт; отсутствие необязательных параметров не выдумывает defaults', async () => {
        const job = scan({ options: undefined, timeoutMs: undefined }); (job.result as { expiresAt: string }).expiresAt = '2020-01-01T00:00:00Z';
        const html = await read(job); expect(ui.buttons.get('Импортировать')?.disabled).toBe(true); expect(html).not.toContain('Температура:'); expect(html).not.toContain('Ожидание ответа:');
    });
    it('Общий источник читается без проекта и без связанной папки',async()=>{
        ui.projectId=undefined;ui.bound=false;const job=scan();Object.assign(job.result!,{scope:'global',deviceId:'computer-one',projectId:undefined,bindingId:undefined,instanceId:undefined});
        await read(job);expect(bridgeApi.create).toHaveBeenCalledWith({kind:'scan-opencode-models',scope:'global',deviceId:'computer-one',requestKey:expect.any(String)});
        expect(ui.buttons.get('Импортировать')?.disabled).toBe(false);
    });
    it('Проектный источник сохраняет binding fence и различает общий/effective выбор',async()=>{
        await read();expect(bridgeApi.create).toHaveBeenCalledWith({kind:'scan-opencode-models',scope:'project',deviceId:'computer-one',projectId:'project-one',expectedBindingId:'binding-one',requestKey:expect.any(String)});
        ui.selects.get('Источник конфигурации OpenCode')!.change('global');const html=render();expect(html).toContain('Привязка папки проекта не нужна');expect(ui.buttons.has('Импортировать')).toBe(false);
    });
    it.each(['old-bridge','offline','unbound'])('Неподходящий %s не отправляет чтение проекта',async kind=>{
        if(kind==='old-bridge')ui.capabilities=['opencode-model-scan-v1'];else if(kind==='offline')ui.online=false;else ui.bound=false;
        render();expect(ui.buttons.get('Прочитать OpenCode')?.disabled).toBe(true);ui.buttons.get('Прочитать OpenCode')!.click!();await flush();expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it.each(['scope','binding','schema','expiry'])('Чужой или непроверенный снимок %s не открывает импорт',async kind=>{
        const job=scan(),result=job.result as unknown as Record<string,unknown>;
        if(kind==='scope')result.scope='global';else if(kind==='binding')result.bindingId='another';else if(kind==='schema')result.schemaVersion=1;else result.expiresAt='invalid';
        const html=await read(job);expect(html).toContain('Снимок не соответствует');expect(ui.buttons.has('Импортировать')).toBe(false);
    });
    it('Обработчик повторно проверяет срок снимка перед отправкой, даже без нового render',async()=>{
        await read();vi.spyOn(Date,'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'));
        try{ui.buttons.get('Импортировать')!.click!();await flush();expect(baseApi.post).not.toHaveBeenCalled();expect(render()).toContain('Снимок конфигурации устарел');}finally{vi.restoreAllMocks();}
    });
});
