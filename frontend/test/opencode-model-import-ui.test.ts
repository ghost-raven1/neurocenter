import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeImportModal } from '../src/features/ModelCatalog/OpenCodeImportModal';
import baseApi from '../src/core/api/base';
import { bridgeApi, type IBridgeJob } from '../src/features/McpBridge/api';

const ui = vi.hoisted(() => ({
    cursor: 0, states: [] as unknown[], refs: [] as unknown[], refCursor: 0, owner: 'admin-a',
    buttons: new Map<string, { click?: () => void; disabled?: boolean }>(), imported: vi.fn(), reload: vi.fn(), job: undefined as IBridgeJob | undefined,
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => { const index = ui.cursor++; if (!(index in ui.states)) ui.states[index] = initial; return [ui.states[index], (value: unknown) => { ui.states[index] = value; }]; },
    useRef: (initial: unknown) => { const index = ui.refCursor++; return ui.refs[index] ??= { current: initial }; },
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => { const owner = ui.owner; return { captureOwner: () => () => owner === ui.owner }; } }));
vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { create: vi.fn() } }));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => ({
    devices: [{ id: 'computer-one', name: 'Компьютер', online: true, report: { bindings: [{ projectId: 'project-one', bindingId: 'binding-one', instanceId: 'instance-one' }], capabilities: ['opencode-model-scan-v1'] } }],
    jobs: ui.job ? [ui.job] : [], errors: {}, devicesReady: true, reload: ui.reload,
}) }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const List = Object.assign(({ dataSource, renderItem }: { dataSource: unknown[]; renderItem: (value: unknown) => ReactNode }) => createElement('div', null, dataSource.map((value, index) => createElement('div', { key: index }, renderItem(value)))), { Item: content });
    return { Modal: content, Space: content, Tag: content, List, Select: () => null, Spin: () => null,
        Typography: { Paragraph: content, Text: content }, Alert: ({ message, description }: { message: string; description?: string }) => createElement('div', null, message, description),
        Button: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => { if (typeof children === 'string') ui.buttons.set(children, { disabled, click: onClick }); return children; },
    };
});

const candidate = { candidateId: 'candidate-one', provider: 'fixture', name: 'Модель из OpenCode', model: 'fixture-chat', capability: 'chat', runtime: 'remote-openai', hasKey: true, blocker: null,
    options: { temperature: 0, topP: 0.8, maxOutputTokens: 2048 }, timeoutMs: 30000 };
const scan = (changes = {}) => ({ id: 'job-one', deviceId: 'computer-one', state: 'succeeded', result: { candidates: [{ ...candidate, ...changes }], warnings: [], expiresAt: '2099-01-01T00:00:00Z' } } as unknown as IBridgeJob);
function render() { ui.cursor = 0; ui.refCursor = 0; ui.buttons.clear(); return renderToStaticMarkup(createElement(OpenCodeImportModal, { projectId: 'project-one', onClose: vi.fn(), onImported: ui.imported })); }
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
async function read(job = scan()) { vi.mocked(bridgeApi.create).mockResolvedValueOnce(job); render(); ui.buttons.get('Прочитать OpenCode')!.click!(); await flush(); return render(); }

beforeEach(() => { vi.clearAllMocks(); ui.states = []; ui.refs = []; ui.owner = 'admin-a'; ui.job = undefined; ui.imported.mockResolvedValue(undefined); });

describe('Импорт модели из доступной конфигурации OpenCode', () => {
    it('Показывает поддерживаемые параметры, явный ноль и таймаут до импорта, не обещая автоматическую синхронизацию', async () => {
        const html = await read();
        expect(html).toContain('Температура: 0'); expect(html).toContain('Top P: 0.8'); expect(html).toContain('2048 токенов'); expect(html).toContain('Ожидание ответа: 30000 мс');
        expect(html).toContain('Импорт выполняется по кнопке'); expect(html).toContain('Ключ остаётся на компьютере');
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
    it('Истёкший снимок не предлагает импорт; старый мост без параметров по-прежнему читается', async () => {
        const job = scan({ options: undefined, timeoutMs: undefined }); (job.result as { expiresAt: string }).expiresAt = '2020-01-01T00:00:00Z';
        const html = await read(job); expect(ui.buttons.get('Импортировать')?.disabled).toBe(true); expect(html).not.toContain('Температура:'); expect(html).not.toContain('Ожидание ответа:');
    });
});
