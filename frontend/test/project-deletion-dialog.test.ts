import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message, Modal } from 'antd';
import bffApi from '../src/core/api/bff';
import ProjectDetail from '../src/modules/Projects/ProjectDetail';

const ui = vi.hoisted(() => ({
    current: true, remove: undefined as (() => void) | undefined,
    confirmation: undefined as { onOk: () => Promise<void>; afterClose: () => void } | undefined,
    effects: [] as Array<() => void | (() => void)>,
    push: vi.fn(), replace: vi.fn(), destroy: vi.fn(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); },
}));
vi.mock('react-redux', () => ({ useSelector: (select: (state: unknown) => unknown) => select({
    userBlock: { user: { activeRole: 'Главный админ', userRoles: ['Главный админ'] } },
    projects: { selectedId: 'prj-a', selected: { id: 'prj-a', name: 'Проект A', logicalBytes: 0, retainedBytes: 0, activeOperations: 0, state: 'ACTIVE' } },
}) }));
vi.mock('react-router-dom', () => ({
    useHistory: () => ({ push: ui.push, replace: ui.replace }),
    useLocation: () => ({ pathname: '/projects/prj-a', search: '?tab=overview', hash: '' }),
    useParams: () => ({ projectId: 'prj-a' }),
}));
vi.mock('../src/core/hooks', () => ({ useAppDispatch: () => vi.fn() }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: 'admin', captureOwner: () => () => ui.current }) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/core/api/bff', () => ({ default: { deleteProject: vi.fn() } }));
vi.mock('../src/modules/Operations/OperationsQueue', () => ({ default: () => null }));
vi.mock('../src/modules/Store/Store', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/ProjectBackups', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/features/RagQuota/RagQuotaPanel', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/RagTab', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/MembersTab', () => ({ default: () => null }));
vi.mock('../src/common/components/StatusTag', () => ({ default: () => null }));
vi.mock('../src/common/components/PageHeading', () => ({ PageHeading: ({ actions }: { actions: ReactNode }) => actions }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    return { Alert: () => null, Col: content, Row: content, Space: content, Spin: () => null, Statistic: () => null, Tabs: () => null,
        Descriptions: Object.assign(content, { Item: content }), Grid: { useBreakpoint: () => ({ sm: true }) }, Result: () => null,
        Typography: { Paragraph: content },
        Button: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => {
            if (children === 'Удалить проект') ui.remove = onClick; return null;
        },
        Modal: { confirm: vi.fn((options: typeof ui.confirmation) => { ui.confirmation = options; return { destroy: ui.destroy }; }) },
        message: { success: vi.fn(), error: vi.fn() },
    };
});

beforeEach(() => {
    vi.clearAllMocks(); ui.current = true; ui.remove = undefined; ui.confirmation = undefined; ui.effects = [];
    vi.mocked(bffApi.deleteProject).mockResolvedValue({ ok: true, id: 'prj-a' });
    renderToStaticMarkup(createElement(ProjectDetail));
});

describe('Подтверждение удаления проекта', () => {
    it('Не отправляет удаление из оставшегося диалога после смены сессии или роли', async () => {
        ui.remove!(); ui.current = false;
        await ui.confirmation!.onOk();
        expect(bffApi.deleteProject).not.toHaveBeenCalled(); expect(ui.push).not.toHaveBeenCalled();
    });

    it('Не перенаправляет новую сессию после позднего успешного удаления', async () => {
        let resolve!: (value: { ok: true; id: string }) => void;
        vi.mocked(bffApi.deleteProject).mockReturnValue(new Promise(done => { resolve = done; }));
        ui.remove!(); const pending = ui.confirmation!.onOk(); ui.current = false;
        resolve({ ok: true, id: 'prj-a' }); await pending;
        expect(message.success).not.toHaveBeenCalled(); expect(ui.push).not.toHaveBeenCalled();
    });

    it('Сохраняет диалог и пояснение отказа для повторной попытки', async () => {
        const failure = new Error('Проект используется выполняющейся операцией');
        vi.mocked(bffApi.deleteProject).mockRejectedValueOnce(failure);
        ui.remove!();
        await expect(ui.confirmation!.onOk()).rejects.toBe(failure);
        expect(message.error).toHaveBeenCalledExactlyOnceWith(failure.message);
        expect(ui.push).not.toHaveBeenCalled();
        await ui.confirmation!.onOk();
        expect(message.success).toHaveBeenCalledOnce(); expect(ui.push).toHaveBeenCalledExactlyOnceWith('/projects');
    });

    it('Повторное нажатие не создаёт два независимых подтверждения', () => {
        ui.remove!(); ui.remove!(); expect(Modal.confirm).toHaveBeenCalledOnce();
    });

    it('Уход со страницы уничтожает подтверждение и обезвреживает его поздний callback', async () => {
        const cleanup = ui.effects[0]() as () => void;
        ui.remove!(); const confirmation = ui.confirmation!; cleanup();
        expect(ui.destroy).toHaveBeenCalledOnce(); await confirmation.onOk();
        expect(bffApi.deleteProject).not.toHaveBeenCalled();
    });

    it('Поздний отказ не уведомляет новую сессию', async () => {
        let reject!: (cause: unknown) => void;
        vi.mocked(bffApi.deleteProject).mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
        ui.remove!(); const pending = ui.confirmation!.onOk(); ui.current = false;
        reject(new Error('Отказ прежнего запроса')); await pending;
        expect(message.error).not.toHaveBeenCalled(); expect(ui.push).not.toHaveBeenCalled();
    });

    it('Повторное подтверждение не отправляет второй DELETE до первого ответа', async () => {
        let resolve!: (value: { ok: true; id: string }) => void;
        vi.mocked(bffApi.deleteProject).mockReturnValue(new Promise(done => { resolve = done; }));
        ui.remove!(); const first = ui.confirmation!.onOk(); await ui.confirmation!.onOk();
        expect(bffApi.deleteProject).toHaveBeenCalledOnce(); resolve({ ok: true, id: 'prj-a' }); await first;
    });

    it('Закрытое подтверждение не мешает снова открыть удаление', () => {
        ui.remove!(); ui.confirmation!.afterClose(); ui.remove!(); expect(Modal.confirm).toHaveBeenCalledTimes(2);
    });
});
