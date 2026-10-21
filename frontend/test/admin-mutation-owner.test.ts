import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from 'antd';
import base from '../src/core/api/base';
import PlatformUsers from '../src/modules/Access/PlatformUsers';
import ProjectBackups from '../src/modules/Projects/components/ProjectBackups';

const ui = vi.hoisted(() => ({
    current: true, stateIndex: 0, states: new Map<number, unknown>(), writes: [] as number[],
    save: undefined as ((values: unknown) => Promise<void>) | undefined,
    backup: undefined as (() => void) | undefined, dispatch: vi.fn(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => {
        const index = ui.stateIndex++;
        return [ui.states.has(index) ? ui.states.get(index) : initial, () => { ui.writes.push(index); }];
    },
}));
vi.mock('react-redux', () => ({ useSelector: (select: (state: unknown) => unknown) => select({ userBlock: { user: { email: 'admin@example.test' } } }) }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => ui.current }) }));
vi.mock('../src/core/hooks', () => ({ useAppDispatch: () => ui.dispatch }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const Form = Object.assign(({ children, onFinish }: { children: ReactNode; onFinish: typeof ui.save }) => {
        ui.save = onFinish; return children;
    }, { Item: content, useForm: () => [{ setFieldsValue: vi.fn(), resetFields: vi.fn(), submit: vi.fn(), getFieldsValue: vi.fn() }] });
    return { Form, Alert: () => null, Checkbox: content, Table: () => null, Tag: content, Space: content,
        Input: Object.assign(() => null, { Search: () => null }), Modal: content,
        Typography: { Text: content, Paragraph: content },
        Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
            if (children === 'Создать резервную копию') ui.backup = onClick; return null;
        }, message: { success: vi.fn() } };
});

function deferred() {
    let resolve!: (value: unknown) => void, reject!: (value: unknown) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
beforeEach(() => {
    vi.clearAllMocks(); ui.current = true; ui.stateIndex = 0; ui.states.clear(); ui.writes = []; ui.save = undefined; ui.backup = undefined;
    vi.mocked(base.get).mockResolvedValue({ data: [] });
});

describe('Поздние административные ответы принадлежат исходной сессии', () => {
    it.each(['success', 'failure'] as const)('Учётная запись: поздний %s не закрывает форму и не перечитывает чужую сессию', async outcome => {
        ui.states.set(0, []); ui.states.set(8, 'new');
        renderToStaticMarkup(createElement(PlatformUsers));
        const pending = deferred(); vi.mocked(base.post).mockReturnValue(pending.promise as ReturnType<typeof base.post>);
        const saved = ui.save!({ email: 'new@example.test', displayName: 'Новый', enabled: true, isMainAdmin: false });
        expect(base.post).toHaveBeenCalledOnce(); const before = ui.writes.length; ui.current = false;
        if (outcome === 'success') pending.resolve({ data: {} }); else pending.reject(new Error('Отказ сервера'));
        await saved;
        expect(message.success).not.toHaveBeenCalled(); expect(base.get).not.toHaveBeenCalled();
        expect(ui.dispatch).not.toHaveBeenCalled(); expect(ui.writes).toHaveLength(before);
    });

    it.each(['success', 'failure'] as const)('Копия проекта: поздний %s не уведомляет другого пользователя', async outcome => {
        renderToStaticMarkup(createElement(ProjectBackups, { projectKey: 'prj-a' }));
        const pending = deferred(); vi.mocked(base.post).mockReturnValue(pending.promise as ReturnType<typeof base.post>);
        ui.backup!(); expect(base.post).toHaveBeenCalledOnce(); const before = ui.writes.length; ui.current = false;
        if (outcome === 'success') pending.resolve({ data: { id: 'backup', projectId: 'prj-a', fileName: 'backup.dump', sizeBytes: 10, createdAt: '2026-10-18T16:00:00Z' } });
        else pending.reject(new Error('Отказ сервера'));
        await flush();
        expect(message.success).not.toHaveBeenCalled(); expect(base.get).not.toHaveBeenCalled(); expect(ui.writes).toHaveLength(before);
    });

    it('Повторное нажатие не запускает вторую копию; текущий владелец получает результат', async () => {
        renderToStaticMarkup(createElement(ProjectBackups, { projectKey: 'prj-a' }));
        const pending = deferred(); vi.mocked(base.post).mockReturnValue(pending.promise as ReturnType<typeof base.post>);
        ui.backup!(); ui.backup!(); expect(base.post).toHaveBeenCalledOnce();
        pending.resolve({ data: { id: 'backup', projectId: 'prj-a', fileName: 'backup.dump', sizeBytes: 10, createdAt: '2026-10-18T16:00:00Z' } });
        await flush(); expect(message.success).toHaveBeenCalledOnce(); expect(base.get).toHaveBeenCalledOnce();
    });
});
