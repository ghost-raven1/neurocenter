import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteConnectionModal } from '../src/features/ModelCatalog/RemoteConnectionModal';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel, IRemoteConnection, IRemoteConnectionHint } from '../src/features/ModelCatalog/types';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [], effects: Array<() => void> = [];
    return {
        begin: () => { cursor = 0; }, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        state<T>(initial: T) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, (value: T) => { slot.value = value; }]; },
        ref<T>(initial: T) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
        effect(effect: () => void | (() => void), deps: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous?.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
            const slot: (typeof slots)[number] = slots[index] = { deps }; effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
type Values = Record<string, unknown>;
const ui = vi.hoisted(() => ({
    owner: 'admin-a', values: {} as Values, fields: new Map<string, { rules?: Array<{ required?: boolean; pattern?:RegExp; validator?:(_rule:unknown,value:unknown)=>Promise<void> }>; extra?: string }>(),
    finish: undefined as ((values: Values) => void) | undefined, change: undefined as (() => void) | undefined,
    saved: vi.fn(), close: vi.fn(), captures:new Map<string,()=>()=>boolean>(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect, useLayoutEffect: hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {const owner=ui.owner;let capture=ui.captures.get(owner);if(!capture){capture=()=>()=>owner===ui.owner;ui.captures.set(owner,capture);}return {scope:owner,captureOwner:capture};} }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { connection: vi.fn(), configure: vi.fn(), get: vi.fn(), operate: vi.fn(), revoke: vi.fn() } }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = () => null;
    const form = { resetFields:()=>{ui.values={};}, setFieldsValue: (values: Values) => { Object.assign(ui.values, values); }, setFieldValue: (name: string, value: unknown) => { ui.values[name] = value; } };
    const Form = Object.assign(({ children, onFinish, onValuesChange }: { children?: ReactNode; onFinish: typeof ui.finish; onValuesChange: typeof ui.change }) => {
        ui.finish = onFinish; ui.change = onValuesChange; return children;
    }, { useForm: () => [form], useWatch: (name: string) => ui.values[name], Item: ({ name, label, rules, extra, children }: { name: string | string[]; label?: string; rules?: Array<{ required?: boolean;pattern?:RegExp;validator?:(_rule:unknown,value:unknown)=>Promise<void> }>; extra?: string; children?: ReactNode }) => {
        ui.fields.set(Array.isArray(name) ? name.join('.') : name, { rules, extra }); return createElement('label', null, label, children, extra);
    } });
    return { Form, Modal: content, Space: content, Spin: input, Checkbox: content, Select: input, InputNumber: input,
        Input: Object.assign(input, { Password: input, TextArea: input }), Collapse: Object.assign(content, { Panel: content }), Popconfirm: content,
        Alert: ({ message, description }: { message: string; description?: string }) => createElement('div', null, message, description),
        Typography: { Paragraph: content }, Button: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => createElement('button', { disabled }, children),
    };
});

const model: ICatalogModel = { id: 'remote-one', name: 'Модель API', description: '', capability: 'chat', runtime: 'remote-openai', model: 'model-v1', modelVersion: 'v1', dimension: null, manifestSha256: null, source: 'custom', revision: 3, createdAt: '', updatedAt: '' };
const view: IRemoteConnection = { modelId: model.id, modelRevision: model.revision, revision: 0, authMode:'required', baseUrl: '', requestDimensions: false, credential: 'none', credentialEnv: null, hasKey: false, checkedAt: null, verified: false, canStoreKey: true, options: {}, timeoutMs: 90000 };
const stored: IRemoteConnection = { ...view, revision: 1, baseUrl: 'https://provider.example/v1', credential: 'stored', hasKey: true };
let selected = model, hint: IRemoteConnectionHint | undefined;
function render(): string { hooks.begin(); ui.fields.clear(); const html = renderToStaticMarkup(createElement(RemoteConnectionModal, { model: selected, hint, onSaved: ui.saved, onClose: ui.close })); hooks.commit(); return html; }
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
async function open(connection: IRemoteConnection = view): Promise<string> { vi.mocked(modelCatalogApi.connection).mockResolvedValueOnce(connection); render(); await flush(); return render(); }
function submit(values: Values = {}): void { ui.finish!({ ...ui.values, baseUrl: 'https://provider.example/v1', ...values }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); ui.captures.clear(); ui.values = {}; ui.owner = 'admin-a'; ui.finish = undefined; selected = model; hint = undefined;
    vi.mocked(modelCatalogApi.configure).mockResolvedValue({ ...stored, modelRevision: 4 }); vi.mocked(modelCatalogApi.get).mockResolvedValue({ ...model, revision: 4 });
    vi.mocked(modelCatalogApi.operate).mockResolvedValue({ state: 'busy', checkedAt: null, message: '' }); ui.saved.mockResolvedValue(undefined);
});
afterEach(() => hooks.dispose());

describe('Общий провайдер без общего ключа и автоматической платной проверки', () => {
    it('Сохраняет приватный JSON адаптера, false/null и непросмотренные параметры без запроса модели',async()=>{
        const options={apiFormat:'responses' as const,reasoningEffort:'high' as const,store:false,providerParameters:{custom:{enabled:false,value:null},seed:42}};
        const html=await open({...stored,options});expect(html).toContain('Дополнительные параметры адаптера (JSON)');expect(html).toContain('Мой доступ');
        expect(html).toContain('Сохранение не выполняет запрос к модели');submit();await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id,expect.objectContaining({options,credential:'none',authMode:'required'}));expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it.each(['none','optional','required'])('Сохраняет режим %s отдельно от персонального секрета',async authMode=>{
        await open(stored);submit({authMode,apiKey:'MUST_NOT_SEND',credentialEnv:'MUST_NOT_SEND'});await flush();
        const body=vi.mocked(modelCatalogApi.configure).mock.calls[0][1];expect(body).toMatchObject({credential:'none',authMode});expect(body).not.toHaveProperty('apiKey');expect(body).not.toHaveProperty('credentialEnv');expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it('Legacy stored/env видны только как история; provider setup доступен без серверного key storage',async()=>{
        const html=await open({...stored,credential:'environment',canStoreKey:false});expect(ui.fields.has('apiKey')).toBe(false);expect(ui.fields.has('credentialEnv')).toBe(false);
        expect(html).toContain('Прежний общий секрет остаётся сохранённым');expect(html).toContain('Новые запросы его не используют');submit();await flush();expect(modelCatalogApi.configure).toHaveBeenCalledOnce();
    });
    it('Явный произвольный JSON не теряет неизвестные параметры и сохраняет нули',async()=>{
        await open(stored);submit({options:{temperature:0,topP:0,providerParameters:'{"seed":0,"custom":{"enabled":false,"value":null}}'}});await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledWith(model.id,expect.objectContaining({options:{temperature:0,topP:0,providerParameters:{seed:0,custom:{enabled:false,value:null}}}}));
    });
    it('Ошибка JSON сохраняет ввод и не запускает provider save или платный probe',async()=>{
        await open(stored);ui.values.options={providerParameters:'{broken'};submit();await flush();expect(modelCatalogApi.configure).not.toHaveBeenCalled();expect(modelCatalogApi.operate).not.toHaveBeenCalled();expect(ui.values.options).toEqual({providerParameters:'{broken'});
    });
    it.each(['new','active','revoked'])('Импорт применяет hints только пустому подключению: %s',async state=>{
        hint={baseUrl:'https://import.example/v1',hasKey:true,options:{temperature:0,maxOutputTokens:2048},timeoutMs:30000};const existing=state==='active';
        const html=await open(existing?{...stored,options:{topP:0.8},timeoutMs:45000}:state==='revoked'?{...view,revision:2}:view);
        expect(ui.values.baseUrl).toBe(existing?stored.baseUrl:hint.baseUrl);expect(ui.values.options).toEqual(existing?{topP:0.8}:hint.options);expect(ui.values.timeoutMs).toBe(existing?45000:30000);
        expect(html).toContain('Ключ OpenCode остаётся на компьютере');expect(ui.values.apiKey).toBeUndefined();
    });
    it.each(['embedding','chat','vision'] as const)('Параметры сохраняют контракт назначения %s',async capability=>{
        selected={...model,capability};await open();expect(ui.fields.has('timeoutMs')).toBe(true);expect(ui.fields.has('options.temperature')).toBe(capability!=='embedding');
        expect(ui.fields.has('options.contextWindow')).toBe(capability!=='embedding');
    });
    it.each([4096,null])('Сохраняет объявленное окно OpenAI или очистку: %s',async contextWindow=>{
        await open({...stored,options:{contextWindow:8192}});submit({options:{contextWindow}});await flush();expect(modelCatalogApi.configure).toHaveBeenCalledWith(model.id,expect.objectContaining({options:contextWindow===null?{}:{contextWindow}}));
    });
    it('После ACK и ошибки перечитывания повторяет только перечитывание каталога',async()=>{
        await open();ui.saved.mockRejectedValueOnce(Error('Каталог временно недоступен'));submit();await flush();expect(render()).toContain('Провайдер сохранён');expect(ui.close).not.toHaveBeenCalled();
        submit();await flush();expect(modelCatalogApi.configure).toHaveBeenCalledOnce();expect(ui.saved).toHaveBeenCalledTimes(2);expect(ui.close).toHaveBeenCalledOnce();expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it('Конфликт CAS сохраняет параметры и не перебазирует провайдера автоматически',async()=>{
        await open(stored);vi.mocked(modelCatalogApi.configure).mockRejectedValueOnce(Error('Карточка изменилась'));ui.values.options={temperature:0.3};submit();await flush();
        expect(render()).toContain('Карточка изменилась');expect(ui.values.options).toEqual({temperature:0.3});expect(modelCatalogApi.configure).toHaveBeenCalledOnce();expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it.each([{modelRevision:5},{modelId:'other-model'}])('Не принимает чужую карточку/ревизию: %j',async change=>{
        const html=await open({...view,...change});expect(html).toContain('Обновите каталог');expect(ui.finish).toBeUndefined();expect(ui.values).toEqual({});
    });
    it('Двойная отправка не дублируется, смена владельца до ACK не закрывает новый экран',async()=>{
        await open();const held=deferred<IRemoteConnection>();vi.mocked(modelCatalogApi.configure).mockReturnValueOnce(held.promise);submit();submit();expect(modelCatalogApi.configure).toHaveBeenCalledOnce();
        ui.owner='admin-b';held.resolve(stored);await flush();expect(ui.saved).not.toHaveBeenCalled();expect(ui.close).not.toHaveBeenCalled();expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it('Закрытый экран не принимает поздний ответ настройки',async()=>{
        const held=deferred<IRemoteConnection>();vi.mocked(modelCatalogApi.connection).mockReturnValueOnce(held.promise);render();hooks.dispose();held.resolve(stored);await flush();expect(ui.values).toEqual({});
    });
});
