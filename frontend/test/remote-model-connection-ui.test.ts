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
    saved: vi.fn(), close: vi.fn(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => { const owner = ui.owner; return () => owner === ui.owner; } }) }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { connection: vi.fn(), configure: vi.fn(), get: vi.fn(), operate: vi.fn(), revoke: vi.fn() } }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = () => null;
    const form = { setFieldsValue: (values: Values) => { Object.assign(ui.values, values); }, setFieldValue: (name: string, value: unknown) => { ui.values[name] = value; } };
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
const view: IRemoteConnection = { modelId: model.id, modelRevision: model.revision, revision: 0, baseUrl: '', requestDimensions: false, credential: 'none', credentialEnv: null, hasKey: false, checkedAt: null, verified: false, canStoreKey: true, options: {}, timeoutMs: 90000 };
const stored: IRemoteConnection = { ...view, revision: 1, baseUrl: 'https://provider.example/v1', credential: 'stored', hasKey: true };
let selected = model, hint: IRemoteConnectionHint | undefined;
function render(): string { hooks.begin(); ui.fields.clear(); const html = renderToStaticMarkup(createElement(RemoteConnectionModal, { model: selected, hint, onSaved: ui.saved, onClose: ui.close })); hooks.commit(); return html; }
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
async function open(connection: IRemoteConnection = view): Promise<string> { vi.mocked(modelCatalogApi.connection).mockResolvedValueOnce(connection); render(); await flush(); return render(); }
function submit(values: Values = {}): void { ui.finish!({ ...ui.values, baseUrl: 'https://provider.example/v1', ...values }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
    hooks.dispose(); vi.clearAllMocks(); ui.values = {}; ui.owner = 'admin-a'; ui.finish = undefined; selected = model; hint = undefined;
    vi.mocked(modelCatalogApi.configure).mockResolvedValue({ ...stored, modelRevision: 4 }); vi.mocked(modelCatalogApi.get).mockResolvedValue({ ...model, revision: 4 });
    vi.mocked(modelCatalogApi.operate).mockResolvedValue({ state: 'busy', checkedAt: null, message: '' }); ui.saved.mockResolvedValue(undefined);
});
afterEach(() => hooks.dispose());

describe('API-ключ и параметры подключения', () => {
    it('Показывает приватный JSON адаптера и сохраняет непросмотренные вложенные поля, false и null',async()=>{
        const options={apiFormat:'responses' as const,reasoningEffort:'high' as const,store:false,providerParameters:{custom:{enabled:false,value:null},seed:42}};
        const html=await open({...stored,options});expect(html).toContain('Дополнительные параметры адаптера (JSON)');expect(html).toContain('64 КиБ');expect(html).toContain('localhost здесь относится к серверу');
        expect(modelCatalogApi.operate).not.toHaveBeenCalled();submit();await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id,expect.objectContaining({options}));expect(modelCatalogApi.operate).toHaveBeenCalledOnce();
    });
    it('Явно введённый произвольный JSON сохраняется без отбрасывания неизвестных параметров',async()=>{
        await open(stored);submit({options:{providerParameters:'{"seed":0,"custom":{"enabled":false,"value":null},"list":[1,"x",false]}'}});await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id,expect.objectContaining({options:{providerParameters:{seed:0,custom:{enabled:false,value:null},list:[1,'x',false]}}}));
    });
    it('Ошибка JSON оставляет форму открытой и не запускает сохранение или тестовую модель',async()=>{
        await open(stored);submit({options:{providerParameters:'{"custom":'}});await flush();
        expect(modelCatalogApi.configure).not.toHaveBeenCalled();expect(modelCatalogApi.operate).not.toHaveBeenCalled();expect(ui.close).not.toHaveBeenCalled();expect(render()).toContain('Исправьте JSON');
    });
    it('Явно объясняет общий scope и тестовый запрос до сохранения, без автоматической проверки при открытии',async()=>{
        const html=await open(stored);expect(html).toContain('общее для команды');expect(html).toContain('тестовый запрос');expect(html).toContain('проект отдельно');expect(modelCatalogApi.operate).not.toHaveBeenCalled();
    });
    it.each(['embedding','chat','vision'] as const)('OpenAI compatibility поля %s принадлежат подключению; Ollama их не показывает',async capability=>{
        selected={...model,capability};await open();expect(ui.fields.has('options.responseModel')).toBe(true);expect(ui.fields.has('options.tokenLimitParameter')).toBe(capability!=='embedding');
        if(capability!=='embedding')expect(ui.fields.get('options.maxOutputTokens')?.extra).toBe('Для max_completion_tokens лимит включает рассуждения и применяется также к проверке подключения. Без лимита проверка запрашивает 64 токена.');
        expect(ui.fields.get('options.responseModel')?.rules?.[0].pattern?.source).toBe('^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$');
        const validate=ui.fields.get('options.responseModel')?.rules?.find(rule=>rule.validator)?.validator;expect(validate).toBeDefined();await expect(validate!({},'https://provider.test/model')).rejects.toThrow('идентификатор');
        await expect(validate!({},'namespace/model:canonical-v1')).resolves.toBeUndefined();await expect(validate!({},undefined)).resolves.toBeUndefined();
        selected={...selected,runtime:'remote-ollama'};render();expect(ui.fields.has('options.responseModel')).toBe(false);expect(ui.fields.has('options.tokenLimitParameter')).toBe(false);expect(ui.fields.get('options.maxOutputTokens')?.extra).toBeUndefined();
    });
    it('Сохраняет ручные OpenAI compatibility настройки только в приватном подключении и запускает одну явную проверку',async()=>{
        await open(stored);submit({options:{responseModel:' canonical-v1 ',tokenLimitParameter:'max_completion_tokens',maxOutputTokens:128}});await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id,expect.objectContaining({expectedRevision:1,expectedModelRevision:3,options:{responseModel:'canonical-v1',tokenLimitParameter:'max_completion_tokens',maxOutputTokens:128}}));
        expect(modelCatalogApi.operate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({revision:4}),'check');
    });
    it('Новое подключение показывает поле ключа и причину недоступного хранения вместо скрытого перехода на env', async () => {
        const html = await open({ ...view, canStoreKey: false });
        expect(ui.values.credential).toBe('stored'); expect(html).toContain('API-ключ'); expect(html).toContain('Хранилище ключей не настроено');
        expect(html).toContain('disabled=""'); expect(ui.fields.get('apiKey')?.rules?.[0].required).toBe(true);
        submit({ apiKey: 'fixture-write-only' }); await flush(); expect(modelCatalogApi.configure).not.toHaveBeenCalled();
        expect(render()).toContain('Выберите ключ из окружения сервера');
    });
    it('Переход с env на stored требует новый ключ, даже если серверная переменная существует', async () => {
        await open({ ...stored, credential: 'environment', credentialEnv: 'NEUROCENTER_REMOTE_MODEL_FIXTURE', hasKey: true });
        ui.values.credential = 'stored'; const html = render();
        expect(ui.fields.get('apiKey')?.rules?.[0].required).toBe(true); expect(html).not.toContain('Ключ уже сохранён');
        submit({ apiKey: '' }); await flush(); expect(modelCatalogApi.configure).not.toHaveBeenCalled(); expect(render()).toContain('Введите API-ключ.');
    });
    it('Сохранённый stored-ключ допускает пустое поле, env не передаёт ранее введённый ключ, нули сохраняются', async () => {
        await open(stored); expect(ui.fields.get('apiKey')?.rules?.[0].required).toBe(false);
        submit({ credential: 'environment', credentialEnv: ' NEUROCENTER_REMOTE_MODEL_FIXTURE ', apiKey: 'never-send-fixture', options: { temperature: 0, topP: 0, maxOutputTokens: null }, timeoutMs: null });
        await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id, { expectedRevision: 1, expectedModelRevision: 3,
            baseUrl: 'https://provider.example/v1', requestDimensions: false, credential: 'environment', credentialEnv: 'NEUROCENTER_REMOTE_MODEL_FIXTURE', options: { temperature: 0, topP: 0 }, timeoutMs: 90000 });
        expect(ui.values.apiKey).toBeUndefined(); expect(ui.saved).toHaveBeenCalledOnce(); expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Смена адреса сохраняет скрытый stored-ключ и непросмотренные параметры без повторного ввода', async () => {
        await open({ ...stored, options: { temperature: 0, maxOutputTokens: 2048 }, timeoutMs: 45000 });
        submit({ apiKey: '' }); await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id, expect.objectContaining({ credential: 'stored', options: { temperature: 0, maxOutputTokens: 2048 }, timeoutMs: 45000 }));
        expect(vi.mocked(modelCatalogApi.configure).mock.calls[0][1]).not.toHaveProperty('apiKey');
    });
    it.each(['new', 'active', 'revoked'])('Импорт применяет параметры только отсутствующему или отозванному подключению: %s', async state => {
        const existing = state === 'active';
        hint = { baseUrl: 'https://import.example/v1', hasKey: true, options: { temperature: 0, maxOutputTokens: 2048 }, timeoutMs: 30000 };
        const html = await open(existing ? { ...stored, options: { topP: 0.8 }, timeoutMs: 45000 } : state === 'revoked' ? { ...view, revision: 2 } : view);
        expect(ui.values.baseUrl).toBe(existing ? stored.baseUrl : hint.baseUrl);
        expect(ui.values.options).toEqual(existing ? { topP: 0.8 } : hint.options); expect(ui.values.timeoutMs).toBe(existing ? 45000 : 30000);
        expect(html.includes('Ключ OpenCode остался на компьютере')).toBe(!existing); expect(ui.values.apiKey).toBeUndefined();
        expect(html.includes('Повторный импорт не заменяет адрес, авторизацию и параметры')).toBe(existing);
        expect(ui.values.credential).toBe('stored'); expect(ui.fields.get('apiKey')?.rules?.[0].required).toBe(!existing);
    });
    it.each(['embedding', 'chat', 'vision'] as const)('Поля параметров соответствуют назначению %s и протоколу', async capability => {
        selected = { ...model, capability }; await open();
        expect(ui.fields.has('timeoutMs')).toBe(true); expect(ui.fields.has('options.temperature')).toBe(capability !== 'embedding');
        expect(ui.fields.has('options.contextWindow')).toBe(capability !== 'embedding');
        if (capability !== 'embedding') expect(ui.fields.get('options.contextWindow')?.extra).toContain('не увеличивает фактический лимит API');
        selected = { ...selected, runtime: 'remote-ollama' }; render(); expect(ui.fields.has('options.contextWindow')).toBe(capability !== 'embedding');
    });
    it.each([4096, null])('Сохраняет заявленное окно OpenAI либо оставляет неизвестным после очистки: %s', async contextWindow => {
        await open({ ...stored, options: { contextWindow: 8192 } });
        expect(ui.values.options).toEqual({ contextWindow: 8192 });
        submit({ options: { contextWindow } }); await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledExactlyOnceWith(model.id, expect.objectContaining({ options: contextWindow == null ? {} : { contextWindow } }));
    });
    it('После сохранения и ошибки перечитывания повторяется проверка, а не сохранение со старой ревизией', async () => {
        await open(); vi.mocked(modelCatalogApi.get).mockRejectedValueOnce(new Error('Сеть недоступна'));
        submit({ apiKey: 'fixture-write-only', options: { temperature: 0.4 } }); await flush();
        expect(render()).toContain('Настройки сохранены. Проверка не запущена: Сеть недоступна'); expect(modelCatalogApi.operate).not.toHaveBeenCalled();
        submit(); await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledOnce(); expect(modelCatalogApi.get).toHaveBeenCalledTimes(2);
        expect(modelCatalogApi.operate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: 4 }), 'check'); expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Редактирование после сохранения и ошибки перечитывания обновляет ревизию до следующего сохранения', async () => {
        await open(); vi.mocked(modelCatalogApi.get).mockRejectedValueOnce(new Error('Сеть недоступна'));
        submit({ apiKey: 'fixture-write-only' }); await flush(); render();
        ui.change!(); render(); submit({ options: { temperature: 0.7 } }); await flush();
        expect(modelCatalogApi.configure).toHaveBeenCalledTimes(2);
        expect(modelCatalogApi.configure).toHaveBeenLastCalledWith(model.id, expect.objectContaining({ expectedRevision: 1, expectedModelRevision: 4, options: { temperature: 0.7 } }));
        expect(modelCatalogApi.get).toHaveBeenCalledTimes(2); expect(ui.close).toHaveBeenCalledOnce();
    });
    it('Конкурентное изменение после сохранения не перебазирует форму и не запускает проверку новой карточки', async () => {
        await open(); vi.mocked(modelCatalogApi.get).mockResolvedValueOnce({ ...model, revision: 5 });
        submit({ apiKey: 'fixture-write-only' }); await flush();
        expect(render()).toContain('Карточка модели изменилась'); expect(modelCatalogApi.operate).not.toHaveBeenCalled();
        vi.mocked(modelCatalogApi.configure).mockRejectedValueOnce(new Error('Карточка уже изменилась'));
        ui.change!(); render(); submit({ options: { temperature: 0.3 } }); await flush();
        expect(modelCatalogApi.configure).toHaveBeenLastCalledWith(model.id, expect.objectContaining({ expectedModelRevision: 4 }));
        expect(modelCatalogApi.operate).not.toHaveBeenCalled(); expect(render()).toContain('Карточка уже изменилась');
    });
    it('Несовпадение ревизии каталога и загруженного подключения требует перечитать каталог до редактирования', async () => {
        const html = await open({ ...view, modelRevision: 5 }); expect(html).toContain('Обновите каталог'); expect(ui.finish).toBeUndefined(); expect(ui.values).toEqual({});
    });
    it('Двойная отправка не дублирует сохранение, потеря владельца не запускает проверку и закрытие', async () => {
        await open(); const pending = deferred<IRemoteConnection>(); vi.mocked(modelCatalogApi.configure).mockReturnValueOnce(pending.promise);
        submit({ apiKey: 'fixture-write-only' }); submit({ apiKey: 'fixture-write-only' });
        expect(modelCatalogApi.configure).toHaveBeenCalledOnce(); ui.owner = 'admin-b'; pending.resolve(stored); await flush();
        expect(modelCatalogApi.get).not.toHaveBeenCalled(); expect(modelCatalogApi.operate).not.toHaveBeenCalled(); expect(ui.saved).not.toHaveBeenCalled(); expect(ui.close).not.toHaveBeenCalled();
    });
    it('Закрытая форма не принимает поздний ответ с настройками и не заполняет новый экран', async () => {
        const pending = deferred<IRemoteConnection>(); vi.mocked(modelCatalogApi.connection).mockReturnValueOnce(pending.promise);
        render(); hooks.dispose(); pending.resolve(stored); await flush(); expect(ui.values).toEqual({}); expect(ui.close).not.toHaveBeenCalled();
    });
});
