import { createElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalInstallations } from '../src/features/McpBridge/LocalInstallations';
import { bridgeApi, type IBridgeInstallation, type IBridgeJob } from '../src/features/McpBridge/api';
import { adminSetupHooks, flushSetup } from './admin-setup-hooks.fixture';
import { bridgeFixture, selection } from './opencode-provider.fixture';

type Button = { children?: ReactNode; disabled?: boolean; onClick?: () => void; 'aria-label'?: string; 'aria-expanded'?: boolean; 'aria-controls'?: string };
type Dialog = { open: boolean; title?: ReactNode; onOk(): void; okButtonProps: { disabled?: boolean } };
const ui = vi.hoisted(() => ({ buttons: new Map<string, Button>(), dialog: undefined as Dialog | undefined }));
let hooks = adminSetupHooks();
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (initial: unknown) => hooks.state(initial), useRef: (initial: unknown) => hooks.ref(initial),
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => hooks.effect(effect, deps) }));
vi.mock('../src/features/McpBridge/api', () => ({ bridgeApi: { create: vi.fn(), cancel: vi.fn() } }));
vi.mock('@ant-design/icons', () => ({ ApiOutlined: () => null, AppstoreOutlined: () => null, DownOutlined: () => null, FileTextOutlined: () => null }));
vi.mock('../src/features/McpBridge/InstallationOperationActions', () => ({ InstallationOperationActions: () => null }));
vi.mock('../src/features/McpBridge/RuntimeProbeStatus', () => ({ RuntimeProbeStatus: () => null }));
vi.mock('../src/features/McpBridge/ProjectInventory', () => ({ ProjectInventory: () => createElement('input', { 'aria-label': 'Поиск в папке' }) }));
vi.mock('../src/features/McpBridge/InstallationInspectionStatus', async original => ({
    ...await original<typeof import('../src/features/McpBridge/InstallationInspectionStatus')>(), InstallationInspectionStatus: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const List = Object.assign(({ dataSource, renderItem }: { dataSource: IBridgeInstallation[]; renderItem(item: IBridgeInstallation): ReactNode }) =>
        createElement('div', null, dataSource.map(item => createElement('div', { key: item.assetId }, renderItem(item)))), { Item: content });
    return { List, Space: content, Tag: content, Collapse: Object.assign(content, { Panel: ({header, children}: {header?: ReactNode; children?: ReactNode}) => createElement('div', null, header, children) }),
        Typography: { Text: ({ children, role }: { children?: ReactNode; role?: string }) => createElement('span', { role }, children), Paragraph: content },
        Card: ({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) => createElement('article', null, createElement('header', null, title, extra), children),
        Button: (props: Button) => {
            ui.buttons.set(props['aria-label'] ?? String(props.children), props);
            return createElement('button', { disabled: props.disabled, 'aria-label': props['aria-label'], 'aria-expanded': props['aria-expanded'], 'aria-controls': props['aria-controls'] }, props.children);
        },
        Modal: (props: Dialog & { children?: ReactNode }) => { ui.dialog = props; return props.open ? createElement('aside', { role: 'dialog' }, props.title, props.children) : null; },
        Tabs: ({ items }: { items: Array<{ key: string; children: ReactNode }> }) => createElement('div', null, items.map(item => createElement('div', { key: item.key }, item.children))),
        Alert: ({ message, description, action, role }: { message: ReactNode; description?: ReactNode; action?: ReactNode; role?: string }) => createElement('div', { role }, message, description, action) };
});

const item = (index: number): IBridgeInstallation => ({ deviceId: selection.deviceId, projectId: selection.projectId,
    bindingId: selection.expectedBindingId, assetKind: 'skill', assetId: 'tool-' + index, name: 'Инструмент ' + index,
    version: 1, manifest: 'b'.repeat(64), updatedAt: '2026-10-24T00:00:00Z' });
const job = (id: string, patch: Partial<IBridgeJob> = {}): IBridgeJob => ({ id, deviceId: selection.deviceId,
    projectId: selection.projectId, bindingId: selection.expectedBindingId, assetKind: 'skill', assetId: 'tool-1',
    kind: 'inspect-installation', state: 'queued', message: 'Проверяем текущие файлы', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', ...patch });
let props: ComponentProps<typeof LocalInstallations>;
// The component callbacks and hidden boundary are exercised here; this is not browser layout evidence.
function render() { hooks.begin(); ui.buttons.clear(); const html = renderToStaticMarkup(createElement(LocalInstallations, props)); hooks.commit(); return html; }
function click(label: string) { const button = ui.buttons.get(label); expect(button, label).toBeDefined(); expect(button!.disabled).not.toBe(true); button!.onClick?.(); }
const panel = (html: string) => html.match(/<section\b[^>]*class="local-installations__content"[^>]*>[\s\S]*?<\/section>/)?.[0];
const outsidePanel = (html: string) => html.replace(panel(html) ?? '', '');
beforeEach(() => {
    hooks = adminSetupHooks(); ui.dialog = undefined; vi.mocked(bridgeApi.create).mockReset(); vi.mocked(bridgeApi.cancel).mockReset().mockResolvedValue({} as never);
    const bridge = bridgeFixture(); bridge.device!.report.capabilities!.push('install-set-v1', 'installation-inspection-v1');
    bridge.installations = Array.from({ length: 8 }, (_, index) => item(index + 1)); bridge.reload = vi.fn(async () => undefined);
    props = { bridge, projectId: selection.projectId, canManage: true, canInspect: true, catalog: [], approved: new Set(bridge.installations.map(row => 'skill:' + row.assetId)) };
});
afterEach(() => hooks.dispose());

describe('Compact local installation summary', () => {
    it('defaults eight installations to collapsed and keeps the list and removal confirmation across toggles', () => {
        let html = render(); expect(ui.buttons.get('Показать установки')).toMatchObject({ 'aria-expanded': false });
        expect(ui.buttons.get('Показать установки')!['aria-controls']).toBeTruthy(); expect(outsidePanel(html)).toContain('Установок: 8');
        expect(panel(html)).toMatch(/\bhidden=""/); expect(panel(html)).toContain('Инструмент 8'); expect(panel(html)).toContain('Поиск в папке');
        click('Показать установки'); html = render(); expect(panel(html)).not.toMatch(/\bhidden=""/);
        click('Удалить с компьютера'); render(); expect(ui.dialog?.open).toBe(true); expect(ui.dialog?.okButtonProps.disabled).toBe(false);
        click('Скрыть установки'); html = render(); expect(panel(html)).toMatch(/\bhidden=""/); expect(ui.dialog?.open).toBe(true);
        props.canManage = false; render(); expect(ui.dialog?.okButtonProps.disabled).toBe(true); expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('keeps current queued cancellation and latest failure visible without reviving historical failures', async () => {
        props.bridge.jobs = [job('queued'), job('latest-failed', { assetId: 'tool-2', kind: 'install', state: 'failed', message: 'Не удалось сохранить комплект' }),
            job('latest-success', { assetId: 'tool-3', kind: 'install', state: 'succeeded', message: 'Установлено' }),
            job('older-failed', { assetId: 'tool-3', kind: 'install', state: 'failed', message: 'Давняя ошибка' }),
            job('previous-folder', { bindingId: 'c'.repeat(64), state: 'failed', message: 'Ошибка прежней папки' }),
            job('other-device', { deviceId: 'another', state: 'failed', message: 'Ошибка чужого компьютера' }),
            job('other-project', { projectId: 'another', state: 'failed', message: 'Ошибка чужого проекта' })];
        props.canManage = false; props.canInspect = false;
        const visible = outsidePanel(render()); expect(visible).toContain('В работе: 1'); expect(visible).toContain('Требуют внимания: 1');
        expect(visible).toContain('Проверяем текущие файлы'); expect(visible).toContain('Не удалось сохранить комплект');
        for (const old of ['Давняя ошибка', 'Ошибка прежней папки', 'Ошибка чужого компьютера', 'Ошибка чужого проекта']) expect(visible).not.toContain(old);
        click('Отменить действие: Инструмент 1'); await flushSetup();
        expect(bridgeApi.cancel).toHaveBeenCalledExactlyOnceWith('queued'); expect(props.bridge.reload).toHaveBeenCalledOnce(); expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('keeps a submission error visible and puts terminal removal recovery in expandable history', async () => {
        vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error('Проверка не отправлена: нет сети'));
        render(); click('Показать установки'); render(); click('Проверить файлы'); await flushSetup(); render();
        click('Скрыть установки');
        props.bridge.jobs = [job('removed', { kind: 'uninstall', state: 'succeeded', message: 'Удаление завершено', result: { recoveryPath: '/private/recovery/fixture' } })];
        const html = render(), visible = outsidePanel(html); expect(visible).toContain('Проверка не отправлена: нет сети'); expect(visible).not.toContain('Удаление завершено');
        expect(visible).not.toContain('/private/recovery/fixture'); expect(panel(html)).toContain('История удалений (1)');
        expect(panel(html)).toContain('Удаление завершено'); expect(panel(html)).toContain('/private/recovery/fixture'); expect(panel(html)).toContain('Резервная копия сохранена локально');
    });
    it('keeps current failed and previous-folder active removal recovery visible, with old terminal receipts in history', async () => {
        props.bridge.jobs = [job('failed-removal', {kind:'uninstall', state:'failed', message:'Текущие файлы изменены'}),
            job('active-old-folder', {assetId:'tool-2', bindingId:'c'.repeat(64), kind:'uninstall', state:'queued', message:'Удаление ожидает подключения'}),
            job('old-failed-removal', {assetId:'tool-3', bindingId:'d'.repeat(64), kind:'uninstall', state:'failed', message:'Ошибка прежней папки'}),
            job('old-success-removal', {assetId:'tool-4', bindingId:'d'.repeat(64), kind:'uninstall', state:'succeeded', message:'Удалено 23 октября'})];
        const html = render(), visible = outsidePanel(html); expect(visible).toContain('Текущие файлы изменены'); expect(visible).toContain('Удаление ожидает подключения');
        expect(visible).toContain('Прежняя папка'); expect(visible).not.toContain('Ошибка прежней папки'); expect(visible).not.toContain('Удалено 23 октября');
        expect(panel(html)).toContain('История удалений (2)'); expect(panel(html)).toContain('Ошибка прежней папки');
        expect(ui.buttons.has('Отменить удаление: Инструмент 2')).toBe(true);
    });
    it('distinguishes an accepted installation from completion and keeps stale-read recovery next to its last-known status', () => {
        props.bridge.jobs = [job('accepted', {kind:'install', state:'queued', message:'Мост принял задание'})];
        props.bridge.jobsReady = false; props.bridge.errors.jobs = 'Не удалось загрузить статусы установок. Попробуйте обновить данные.';
        const visible = outsidePanel(render()); expect(visible).toContain('Задание принято'); expect(visible).toContain('Выполнение ещё не подтверждено');
        expect(visible).toContain('Не удалось загрузить статусы установок'); expect(visible).toContain('Последние полученные статусы');
        expect(ui.buttons.has('Обновить статусы')).toBe(true); expect(bridgeApi.create).not.toHaveBeenCalled();
    });
    it('rebind keeps an earlier inspection error in its historical row, outside the current folder summary', async () => {
        const oldItem=item(1),message='Проверка папки A не отправлена';
        props.bridge.installations=[oldItem];vi.mocked(bridgeApi.create).mockRejectedValueOnce(new Error(message));
        render();if(ui.buttons.has('Показать установки')){click('Показать установки');render();}
        click('Проверить файлы');await flushSetup();render();
        if(ui.buttons.has('Скрыть установки')){click('Скрыть установки');render();}
        const nextBinding='d'.repeat(64),device=props.bridge.device!;
        props.bridge.device={...device,report:{...device.report,bindings:[{projectId:selection.projectId,bindingId:nextBinding,folderName:'Папка B',valid:true}]}};
        props.bridge.installations=[{...item(2),bindingId:nextBinding},oldItem];
        const html=render(),history=html.match(/<article\b[^>]*class="local-installations__item local-installations__item--history"[^>]*>[\s\S]*?<\/article>/)?.[0];
        expect(history).toContain(message);const current=html.replace(history!,'');
        expect(current).not.toContain(message);expect(current).not.toContain('Требуют внимания');
        expect(bridgeApi.create).toHaveBeenCalledOnce();
    });
});
