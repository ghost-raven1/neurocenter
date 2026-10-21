import './feature-flags-enabled';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeJob } from '../src/features/McpBridge/api';
import { bridgeApi } from '../src/features/McpBridge/api';
import { WorkspaceBindingWizard } from '../src/features/McpBridge/WorkspaceBindingWizard';
import type { useBridge } from '../src/features/McpBridge/useBridge';

const ui = vi.hoisted(() => ({
    buttons: new Map<string, {onClick?: () => void; disabled?: boolean}>(),
    operation: {job: undefined as IBridgeJob | undefined, busy: false, error: '', setError: vi.fn(), submit: vi.fn(), canRetry:()=>false},
}));

vi.mock('../src/features/McpBridge/useLocalJob', () => ({useLocalJob: () => ui.operation}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope:'fixture',captureOwner:()=>()=>true})}));
vi.mock('../src/features/McpBridge/api', () => ({bridgeApi: {cancel: vi.fn()}}));
vi.mock('antd', async importOriginal => {
    const actual = await importOriginal<typeof import('antd')>();
    const {createElement: h} = await import('react');
    return {
        ...actual,
        Modal: ({open, children}: {open: boolean; children?: ReactNode}) => open ? h('div', null, children) : null,
        Button: (props: Parameters<typeof actual.Button>[0]) => {
            if (typeof props.children === 'string') { ui.buttons.set(props.children, props as {onClick?: () => void; disabled?: boolean}); }
            return h(actual.Button, props);
        },
    };
});

function fixture() {
    const device: IBridgeDevice = {
        id: 'computer', name: 'Мой компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: {protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'workspace-instance-v1'],
            root: '/fixture/projects', folders: ['Мой проект'], bindings: [{projectId: 'project', folderName: 'Мой проект',
                valid: true, bindingId: 'a'.repeat(64), instanceId: '11111111-1111-1111-1111-111111111111', identityStatus: 'verified'}]},
    };
    return {device, devices: [device], jobs: [] as IBridgeJob[], installations: [], devicesReady: true, jobsReady: true,
        installationsReady: true, loading: false, errors: {devices: '', jobs: '', installations: ''}, error: '',
        reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined), choose: vi.fn()};
}
let bridge: ReturnType<typeof fixture>;
function render(canManage = true) {
    return renderToStaticMarkup(createElement(WorkspaceBindingWizard, {bridge: bridge as ReturnType<typeof useBridge>,
        project: {id: 'project', name: 'Проект'}, canManage, onClose: vi.fn()}));
}
function pending(state: string): IBridgeJob {
    return {id: 'previous-check', deviceId: bridge.device.id, projectId: 'project', kind: 'prepare-bind-project', state,
        message: 'Мост проверяет выбранную ранее папку', createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z'};
}
const checkButton = () => ui.buttons.get('Проверить папку');

beforeEach(() => {
    vi.clearAllMocks(); ui.buttons.clear(); bridge = fixture(); ui.operation.job = undefined; ui.operation.busy = false; ui.operation.error = '';
    vi.mocked(bridgeApi.cancel).mockResolvedValue(undefined);
});

describe('Мастер объясняет блокировку проверки папки и показывает выход', () => {
    it('Выбранная папка доступного компьютера разрешает проверку', () => {
        render();
        expect(checkButton()).toBeDefined();
        expect(checkButton()?.disabled).toBe(false);
    });

    it.each(['devices', 'jobs'] as const)('Ошибка чтения %s отображается рядом с повтором загрузки', async resource => {
        bridge.errors[resource] = 'Не удалось загрузить данные для проверки папки';
        if (resource === 'devices') { bridge.devicesReady = false; } else { bridge.jobsReady = false; }
        const html = render();
        expect(html).toContain(bridge.errors[resource]);
        expect(checkButton()?.disabled).toBe(true);
        const refresh = ui.buttons.get('Обновить данные');
        expect(refresh?.onClick).toBeTypeOf('function');
        refresh?.onClick?.();
        await vi.waitFor(() => expect(bridge.reload).toHaveBeenCalledOnce());
    });

    it('Старое ожидающее задание показывает причину и отменяется прямо в мастере', async () => {
        const job = pending('queued'); bridge.jobs = [job];
        const html = render();
        expect(html).toContain(job.message);
        expect(checkButton()?.disabled).toBe(true);
        const cancel = ui.buttons.get('Отменить');
        expect(cancel?.onClick).toBeTypeOf('function');
        expect(cancel?.disabled).not.toBe(true);
        cancel?.onClick?.();
        await vi.waitFor(() => expect(bridgeApi.cancel).toHaveBeenCalledExactlyOnceWith(job.id));
        await vi.waitFor(() => expect(bridge.reload).toHaveBeenCalledOnce());
    });

    it.each(['running', 'reconciling'])('Состояние %s сохраняет блокировку и не предлагает отмену начатой работы', state => {
        const job = pending(state); bridge.jobs = [job];
        const html = render();
        expect(html).toContain(job.message);
        expect(checkButton()?.disabled).toBe(true);
        expect(ui.buttons.has('Отменить')).toBe(false);
    });

    it('Действие другого проекта на том же компьютере не блокирует проверку', () => {
        bridge.jobs = [{...pending('queued'), projectId: 'another-project'}];
        render();
        expect(checkButton()?.disabled).toBe(false);
    });

    it('Отсутствие права изменения проекта сохраняет запрет с явной причиной', () => {
        const html = render(false);
        expect(html).toContain('Для привязки нужна роль разработчика');
        expect(checkButton()?.disabled).toBe(true);
    });

    it('Недоступный компьютер сохраняет запрет с просьбой подключить мост', () => {
        bridge.device.online = false;
        const html = render();
        expect(html).toContain('Включите компьютер');
        expect(checkButton()?.disabled).toBe(true);
    });

    it('Устаревший мост сохраняет запрет с просьбой обновиться', () => {
        bridge.device.report.capabilities = ['durable-completions', 'managed-installations'];
        const html = render();
        expect(html).toContain('Обновите мост');
        expect(checkButton()?.disabled).toBe(true);
    });
});
