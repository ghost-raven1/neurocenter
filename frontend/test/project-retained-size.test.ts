import { createElement, type ReactNode, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Projects from '../src/modules/Projects/Projects';
import ProjectDetail from '../src/modules/Projects/ProjectDetail';

const ui = vi.hoisted(() => ({
    state: {} as Record<string, unknown>, owner: true,
    retry: undefined as (() => void) | undefined, logicalRetry: undefined as (() => void) | undefined,
    dispatch: vi.fn(), push: vi.fn(), replace: vi.fn(),
    listRead: vi.fn((params: unknown) => ({ type: 'readProjects', payload: params })),
    detailRead: vi.fn((id: string) => ({ type: 'readProject', payload: id })),
}));
vi.mock('react-redux', () => ({ useSelector: (select: (state: unknown) => unknown) => select(ui.state) }));
vi.mock('../src/core/hooks', () => ({ useAppDispatch: () => ui.dispatch }));
vi.mock('react-router-dom', () => ({
    useHistory: () => ({ push: ui.push, replace: ui.replace }),
    useLocation: () => ({ pathname: '/projects/prj-a', search: '?tab=overview&from=search', hash: '#position' }),
    useParams: () => ({ projectId: 'prj-a' }),
}));
vi.mock('../src/modules/Projects/redux/actions', () => ({ fetchProjects: ui.listRead, fetchProject: ui.detailRead }));
vi.mock('../src/modules/Projects/redux/reducers', () => ({ clearSelected: vi.fn(), setPage: vi.fn(), setQuery: vi.fn() }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => ui.owner }) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/modules/Projects/components/CreateProjectModal', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/local/LocalProjectsFolder', () => ({ LocalProjectsFolder: () => null }));
vi.mock('../src/common/components/Permission', () => ({ default: () => null }));
vi.mock('../src/common/components/StatusTag', () => ({ default: () => null }));
vi.mock('../src/common/components/AsyncButton', () => ({ default: () => null }));
vi.mock('../src/common/components/PageHeading', () => ({ PageHeading: () => null }));
vi.mock('../src/modules/Operations/OperationsQueue', () => ({ default: () => null }));
vi.mock('../src/modules/Store/Store', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/ProjectBackups', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/features/RagQuota/RagQuotaPanel', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/RagTab', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/MembersTab', () => ({ default: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    return {
        Alert: () => null, Card: content, Col: content, Row: content, Space: content, Popconfirm: content,
        Spin: () => null, Result: () => null, Grid: { useBreakpoint: () => ({ sm: true }) },
        Descriptions: Object.assign(content, { Item: content }), Typography: { Paragraph: content, Text: content },
        Input: { Search: () => null }, Modal: { confirm: vi.fn() }, message: {},
        Tabs: ({ items, activeKey }: { items: Array<{ key: string; children: ReactNode }>; activeKey: string }) => items.find(item => item.key === activeKey)?.children,
        Table: ({ dataSource, columns }: { dataSource: Array<{ retainedBytes?: unknown }>; columns: Array<{ key: string; render: (value: unknown, row: unknown) => ReactNode }> }) => {
            return dataSource.map((row, index) => createElement('div', { key: index }, ...columns.filter(column => ['retained', 'bytes'].includes(column.key)).map(column => createElement('div', { key: column.key }, column.render(column.key === 'retained' ? row.retainedBytes : (row as { logicalBytes?: unknown }).logicalBytes, row)))));
        },
        Statistic: ({ title, value, formatter }: { title: string; value?: string | number; formatter?: (value: string | number) => ReactNode }) => createElement('section', {}, title, formatter ? formatter(value ?? 0) : value ?? 0),
        Button: ({ children, onClick, ...props }: { children?: ReactNode; onClick?: (event: MouseEvent<HTMLElement>) => void; 'aria-label'?: string }) => {
            if (props['aria-label'] === 'Повторить измерение копии знаний') { ui.retry = () => onClick?.({ stopPropagation: () => undefined } as MouseEvent<HTMLElement>); }
            if (props['aria-label'] === 'Повторить измерение данных проекта') { ui.logicalRetry = () => onClick?.({ stopPropagation: () => undefined } as MouseEvent<HTMLElement>); }
            return createElement('button', { 'aria-label': props['aria-label'] }, children);
        },
    };
});

const reason = 'Сервис базы знаний временно недоступен. Повторите измерение.';
function setup(bytes: unknown, retainedSizeError?: unknown) {
    const project = { id: 'prj-a', name: 'Проект A', logicalBytes: 24, retainedBytes: bytes, retainedSizeError, activeOperations: 0, state: 'ACTIVE' };
    ui.state = {
        userBlock: { user: { activeRole: 'Разработчик', userRoles: ['Разработчик'] } },
        projects: { selectedId: 'prj-a', selected: project, list: [project], page: 3, size: 10, total: 40, query: 'нужный проект', authScope: 'owner', loading: false, selectedLoading: false },
    };
}
function render(kind: 'list' | 'detail') { return renderToStaticMarkup(createElement(kind === 'list' ? Projects : ProjectDetail)); }
beforeEach(() => { vi.clearAllMocks(); ui.owner = true; ui.retry = undefined; ui.logicalRetry = undefined; setup(null, reason); });

for (const kind of ['list', 'detail'] as const) {
    describe(`Размер копии знаний: ${kind}`, () => {
        it.each([null, undefined, -1, NaN, Infinity, '0'])('Не выдаёт неизвестный или некорректный размер %s за пустую копию', bytes => {
            setup(bytes, reason); const markup = render(kind);
            expect(markup).toContain('Недоступно'); expect(markup).toContain(reason);
            expect(ui.retry).toBeTypeOf('function');
        });
        it('Отличает реальный нулевой размер от недоступного', () => {
            setup(0); const markup = render(kind);
            expect(markup).toContain('0 Б'); expect(markup).not.toContain('Недоступно'); expect(ui.retry).toBeUndefined();
        });
        it('Здоровое повторное измерение убирает прежнее предупреждение', () => {
            expect(render(kind)).toContain(reason);
            setup(2048, reason); const markup = render(kind);
            expect(markup).toContain('2 КБ'); expect(markup).not.toContain(reason); expect(markup).not.toContain('Недоступно');
        });
        it('Отсутствующее пояснение получает понятную замену', () => {
            setup(null, '   '); expect(render(kind)).toContain('Не удалось измерить копию знаний. Повторите попытку.');
        });
        it('Повтор читает текущий проект или страницу и сохраняет URL', () => {
            render(kind); expect(ui.retry).toBeTypeOf('function'); ui.retry!();
            if (kind === 'list') expect(ui.listRead).toHaveBeenCalledExactlyOnceWith({ page: 3, size: 10, query: 'нужный проект' });
            else expect(ui.detailRead).toHaveBeenCalledExactlyOnceWith('prj-a');
            expect(ui.push).not.toHaveBeenCalled(); expect(ui.replace).not.toHaveBeenCalled();
        });
        it('Старый обработчик не начинает чтение после смены владельца', () => {
            render(kind); expect(ui.retry).toBeTypeOf('function'); ui.owner = false; ui.retry!();
            expect(ui.listRead).not.toHaveBeenCalled(); expect(ui.detailRead).not.toHaveBeenCalled(); expect(ui.dispatch).not.toHaveBeenCalled();
        });
    });
}

for (const kind of ['list', 'detail'] as const) {
    describe(`Размер данных проекта: ${kind}`, () => {
        it.each([null, undefined, -1, NaN, Infinity, '0'])('Не маскирует неизвестный размер %s нулём', logicalBytes => {
            setup(1000);
            const project = (ui.state.projects as { selected: Record<string, unknown> }).selected;
            project.logicalBytes = logicalBytes; project.logicalSizeError = 'Файлы проекта временно недоступны.';
            const markup = render(kind);
            expect(markup).toContain('Недоступно'); expect(markup).toContain('Файлы проекта временно недоступны.');
            expect(ui.logicalRetry).toBeTypeOf('function'); ui.logicalRetry!();
            if (kind === 'list') expect(ui.listRead).toHaveBeenCalledExactlyOnceWith({ page: 3, size: 10, query: 'нужный проект' });
            else expect(ui.detailRead).toHaveBeenCalledExactlyOnceWith('prj-a');
        });
        it('Показывает настоящий пустой каталог как 0 Б и убирает старую ошибку', () => {
            setup(1000);
            const project = (ui.state.projects as { selected: Record<string, unknown> }).selected;
            project.logicalBytes = 0; project.logicalSizeError = 'Предыдущий отказ';
            const markup = render(kind);
            expect(markup).toContain('0 Б'); expect(markup).not.toContain('Предыдущий отказ'); expect(ui.logicalRetry).toBeUndefined();
        });
        it('Не начинает старое измерение данных после смены владельца', () => {
            setup(1000); (ui.state.projects as { selected: Record<string, unknown> }).selected.logicalBytes = null;
            render(kind); expect(ui.logicalRetry).toBeTypeOf('function'); ui.owner = false; ui.logicalRetry!();
            expect(ui.dispatch).not.toHaveBeenCalled();
        });
    });
}
