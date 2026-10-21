import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeModelSyncSettings } from '../src/features/ModelCatalog/OpenCodeModelSyncSettings';
import baseApi from '../src/core/api/base';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';

const ui = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], refs: [] as unknown[], refCursor: 0, owner: 'admin-a', isMain: true,
    buttons: new Map<string, { click?: () => void; disabled?: boolean }>(), switches: new Map<string, { change?: (value: boolean) => void; disabled?: boolean; checked?: boolean }>() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const index = ui.cursor++; if (!(index in ui.states)) ui.states[index] = initial; return [ui.states[index], (value: unknown) => { ui.states[index] = value; }]; },
    useRef: (initial: unknown) => { const index = ui.refCursor++; return ui.refs[index] ??= { current: initial }; },
}));
vi.mock('react-redux', () => ({ useSelector: () => ui.isMain }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const owner = ui.owner; return { captureOwner: () => () => owner === ui.owner }; } }));
vi.mock('../src/core/api/base', () => ({ default: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { get: vi.fn(), operate: vi.fn() } }));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({ RemoteConnectionModal: ({ model }: { model: { id: string } }) => createElement('div', null, 'Connection: ' + model.id) }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const List = Object.assign(({ dataSource, renderItem }: { dataSource: unknown[]; renderItem: (value: unknown) => ReactNode }) => createElement('div', null, dataSource.map((value, index) => createElement('div', { key: index }, renderItem(value)))),
        { Item: ({ children, actions }: { children?: ReactNode; actions?: ReactNode[] }) => createElement('div', null, children, actions) });
    return { Modal: content, Space: content, List, Spin: () => null, Typography: { Paragraph: content, Text: content },
        Alert: ({ message }: { message: string }) => createElement('div', null, message),
        Switch: ({ 'aria-label': label, disabled, checked, onChange }: { 'aria-label': string; disabled?: boolean; checked?: boolean; onChange?: (value: boolean) => void }) => { ui.switches.set(label, { disabled, checked, change: onChange }); return null; },
        Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => { if (typeof children === 'string') ui.buttons.set(children, { disabled, click: onClick }); return children; },
    };
});
const enabledLabel = 'Автоматически добавлять модели OpenCode', secretLabel = 'Разрешить перенос API-ключей с компьютера';
const settings = { revision: 0, enabled: true, transferCredentials: false, canTransferCredentials: true, sources: [] };
const render = (): string => { ui.cursor = 0; ui.refCursor = 0; ui.buttons.clear(); ui.switches.clear(); return renderToStaticMarkup(createElement(OpenCodeModelSyncSettings, { deviceId: 'computer-one', supported: true })); };
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
const open = async (value = settings): Promise<string> => { vi.mocked(baseApi.get).mockResolvedValueOnce({ data: value }); render(); ui.buttons.get('Модели OpenCode')!.click!(); await flush(); return render(); };
beforeEach(() => { vi.clearAllMocks(); ui.states = []; ui.refs = []; ui.owner = 'admin-a'; ui.isMain = true; });

describe('OpenCode computer consent settings', () => {
    it('loads only after opening, defaults transfer off and explains safe explicit activation', async () => {
        render(); expect(baseApi.get).not.toHaveBeenCalled();
        const html = await open(); expect(ui.switches.get(enabledLabel)?.checked).toBe(true); expect(ui.switches.get(secretLabel)?.checked).toBe(false);
        expect(html).toContain('зашифрованном виде'); expect(html).toContain('уже сохранённый ключ'); expect(html).toContain('примерно раз в минуту');
    });
    it('sends only boolean consent and its CAS revision; it never asks browser to read a local key', async () => {
        await open(); vi.mocked(baseApi.put).mockResolvedValueOnce({ data: { ...settings, revision: 1, transferCredentials: true } });
        ui.switches.get(secretLabel)!.change!(true); await flush(); render();
        expect(baseApi.put).toHaveBeenCalledExactlyOnceWith('/api/devices/computer-one/opencode-model-sync', { expectedRevision: 0, enabled: true, transferCredentials: true });
        expect(ui.switches.get(secretLabel)?.checked).toBe(true); expect(JSON.stringify(vi.mocked(baseApi.put).mock.calls)).not.toContain('apiKey');
    });
    it('disables key transfer without server encryption and retains the previous setting after failed save', async () => {
        await open({ ...settings, canTransferCredentials: false }); expect(ui.switches.get(secretLabel)?.disabled).toBe(true);
        vi.mocked(baseApi.put).mockRejectedValueOnce(new Error('Настройка изменилась')); ui.switches.get(enabledLabel)!.change!(false); await flush();
        expect(render()).toContain('Настройка изменилась'); expect(ui.switches.get(enabledLabel)?.checked).toBe(true);
    });
    it('late responses after owner switch cannot change the displayed settings', async () => {
        let resolve!: (value: unknown) => void; vi.mocked(baseApi.get).mockReturnValueOnce(new Promise(done => { resolve = done; }));
        render(); ui.buttons.get('Модели OpenCode')!.click!(); ui.owner = 'admin-b'; resolve({ data: { ...settings, transferCredentials: true } }); await flush();
        render(); expect(ui.switches.has(secretLabel)).toBe(false);
    });
    it('opens an existing server connection from source metadata with per-model capacities', async () => {
        const html = await open({ ...settings, sources: [{ projectId: 'project-one', provider: 'team', configKey: 'alias', modelId: 'model-one', name: 'Team model', state: 'present', credentialStatus: 'pending', contextWindow: 128000, outputTokenLimit: 64000 }] } as typeof settings);
        expect(html).toContain('Нужен ключ на сервере'); expect(html).toContain('Контекст:'); expect(html).toContain('Предел ответа:');
        vi.mocked(modelCatalogApi.get).mockResolvedValueOnce({ id: 'model-one', revision: 1 } as never);
        ui.buttons.get('Подключение')!.click!(); await flush(); expect(render()).toContain('Connection: model-one');
        expect(modelCatalogApi.get).toHaveBeenCalledExactlyOnceWith('model-one');
    });
    it('is hidden from other active roles', () => { ui.isMain = false; expect(render()).toBe(''); expect(baseApi.get).not.toHaveBeenCalled(); });
    it('shows a separate explicit API check and never starts it while simply reading discovery metadata', async () => {
        await open({ ...settings, sources: [{ projectId: 'project-one', provider: 'team', configKey: 'alias', modelId: 'model-one', name: 'Team model', state: 'present', credentialStatus: 'transferred', contextWindow: 128000, outputTokenLimit: 64000, assigned: true, needsCheck: true, hasServerKey: true, revoked: false, archivedAt: null }] } as typeof settings);
        expect(ui.buttons.get('Проверить')?.disabled).toBe(false); expect(modelCatalogApi.operate).not.toHaveBeenCalled();
        const model = { id: 'model-one', revision: 1 }; vi.mocked(modelCatalogApi.get).mockResolvedValueOnce(model as never); vi.mocked(modelCatalogApi.operate).mockResolvedValueOnce({ state: 'busy' } as never);
        ui.buttons.get('Проверить')!.click!(); await flush(); expect(modelCatalogApi.operate).toHaveBeenCalledExactlyOnceWith(model, 'check');
        expect(render()).toContain('Проверка подключения запущена');
    });
});
