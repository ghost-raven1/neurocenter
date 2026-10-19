import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalog } from '../src/features/ModelCatalog/ModelCatalog';
import { modelCatalogApi } from '../src/features/ModelCatalog/api';
import type { ICatalogModel, IModelCatalog, IModelCreate } from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({
    index: 0, states: [] as unknown[], buttons: new Map<string, () => void>(),
    catalog: null as IModelCatalog | null, nextCatalog: null as IModelCatalog | null, refresh: vi.fn(),
    query: '', changeQuery: undefined as ((event: { target: { value: string } }) => void) | undefined,
    assignedOnly: true, submit: undefined as ((values: IModelCreate) => void) | undefined,
    cards: [] as Array<{ model: ICatalogModel; assigned: boolean; canAssign: boolean }>,
    view: undefined as (() => void) | undefined, edit: undefined as (() => void) | undefined,
}));

vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => {
        const index = ui.index++;
        if (!(index in ui.states)) ui.states[index] = initial;
        return [ui.states[index], (value: unknown) => { ui.states[index] = value; }];
    },
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => true }) }));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({ useModelCatalog: () => ({ catalog: ui.catalog, loading: false, error: '', refresh: ui.refresh }) }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: { create: vi.fn(), update: vi.fn(), assign: vi.fn() } }));
vi.mock('../src/features/ModelCatalog/ModelCard', () => ({ ModelCard: (props: typeof ui.cards[number] & { onView: () => void }) => {
    ui.cards.push(props); ui.view = props.onView; return null;
} }));
vi.mock('../src/features/ModelCatalog/ModelDetails', () => ({ ModelDetails: ({ onEdit }: { onEdit: () => void }) => { ui.edit = onEdit; return null; } }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = () => null;
    const Form = Object.assign(({ children, onFinish }: { children?: ReactNode; onFinish: typeof ui.submit }) => {
        ui.submit = onFinish; return children;
    }, { Item: content, useForm: () => [{}], useWatch: () => 'chat' });
    return {
        Form, Modal: content, Space: content, Row: content, Col: content, Spin: () => null, Empty: content,
        Alert: ({ message }: { message: string }) => message,
        Typography: { Title: content, Text: content, Paragraph: content },
        Input: Object.assign(input, { TextArea: input, Search: ({ value, onChange }: { value: string; onChange: typeof ui.changeQuery }) => {
            ui.query = value; ui.changeQuery = onChange; return null;
        } }), InputNumber: input, Select: input,
        Checkbox: ({ checked, children }: { checked: boolean; children?: ReactNode }) => { ui.assignedOnly = checked; return children; },
        Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
            if (typeof children === 'string' && onClick) ui.buttons.set(children, onClick); return children;
        },
    };
});

const model = (id: string, name: string): ICatalogModel => ({ id, name, description: '', model: 'qwen3:4b', capability: 'chat', runtime: 'ollama',
    manifestSha256: null, dimension: null, source: 'custom', revision: 1, createdAt: '2026-10-19', updatedAt: '2026-10-19' });
const existing = model('model-existing', 'Старый'), created = model('model-new', 'Новый');
const values: IModelCreate = { name: created.name, description: 'Новая модель', capability: 'chat', model: created.model };

function render() {
    ui.index = 0; ui.cards = []; ui.buttons.clear();
    return renderToStaticMarkup(createElement(ModelCatalog, { projectId: 'project-one', embedded: true, canManage: true, isMain: true }));
}
async function flush() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function search() { render(); ui.changeQuery!({ target: { value: 'Старый' } }); render(); }
function create() { search(); ui.buttons.get('Добавить модель')!(); render(); ui.submit!(values); }

beforeEach(() => {
    vi.clearAllMocks(); ui.states = []; ui.query = ''; ui.assignedOnly = true; ui.submit = undefined; ui.view = undefined; ui.edit = undefined;
    ui.catalog = { items: [existing], assignedModelIds: [existing.id] };
    ui.nextCatalog = { items: [existing, created], assignedModelIds: [existing.id] };
    ui.refresh.mockImplementation(async () => { ui.catalog = ui.nextCatalog; });
});

describe('Новая модель видна после сохранения в проектном каталоге', () => {
    it('Успешное создание снимает фильтры и показывает карточку для явного назначения проекту', async () => {
        const pending = deferred<ICatalogModel>(); vi.mocked(modelCatalogApi.create).mockReturnValueOnce(pending.promise);
        create(); render(); expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true);
        pending.resolve(created); await flush(); render();
        expect(ui.query).toBe(''); expect(ui.assignedOnly).toBe(false);
        expect(ui.cards).toContainEqual(expect.objectContaining({ model: created, assigned: false, canAssign: true }));
        expect(modelCatalogApi.assign).not.toHaveBeenCalled(); expect(ui.refresh).toHaveBeenCalledOnce();
    });

    it('Ошибка создания сохраняет фильтры, форму и введённые данные без перечитывания каталога', async () => {
        vi.mocked(modelCatalogApi.create).mockRejectedValueOnce(new Error('Модель с таким названием уже есть'));
        create(); await flush(); const html = render();
        expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true);
        expect(html).toContain('Модель с таким названием уже есть'); expect(html).toContain('Сохранить');
        expect(ui.refresh).not.toHaveBeenCalled(); expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });

    it('Редактирование существующей модели сохраняет поиск и фильтр проекта', async () => {
        ui.nextCatalog = { items: [existing], assignedModelIds: [existing.id] };
        vi.mocked(modelCatalogApi.update).mockResolvedValueOnce(existing);
        search(); ui.view!(); render(); ui.edit!(); render(); ui.submit!({ ...values, name: existing.name });
        await flush(); render();
        expect(ui.query).toBe('Старый'); expect(ui.assignedOnly).toBe(true); expect(ui.refresh).toHaveBeenCalledOnce();
        expect(modelCatalogApi.create).not.toHaveBeenCalled(); expect(modelCatalogApi.assign).not.toHaveBeenCalled();
    });
});
