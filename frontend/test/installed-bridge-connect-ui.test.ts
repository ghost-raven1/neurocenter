import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import { InstalledBridgeConnect } from '../src/features/McpBridge/InstalledBridgeConnect';
import { installedBridgeCommand } from '../src/features/McpBridge/connectionCommands';
import { BridgeSetup } from '../src/modules/Start/BridgeSetup';
import { PairingCode } from '../src/features/McpBridge/PairingCode';

const fixture = vi.hoisted(() => ({
    bridge: undefined as unknown as ReturnType<typeof useBridge>,
    buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
    push: vi.fn(),
    search: '',
    connectAnother: undefined as (() => void) | undefined,
}));
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => fixture.bridge }));
vi.mock('../src/features/McpBridge/BridgeSourcePanel', () => ({BridgeSourcePanel:()=>null}));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: fixture.push, location: { pathname: '/start', search: fixture.search } }) }));
vi.mock('../src/features/McpBridge/BridgeDevicesManager', () => ({ BridgeDevicesManager: ({ onConnect }: { onConnect: () => void }) => {
    fixture.connectAnother = onConnect; return null;
} }));
vi.mock('antd', async importOriginal => {
    const actual = await importOriginal<typeof import('antd')>();
    return { ...actual, Button: (props: Parameters<typeof actual.Button>[0]) => {
        if (typeof props.children === 'string') { fixture.buttons.set(props.children, props as { onClick?: () => void; disabled?: boolean }); }
        return createElement(actual.Button, props);
    } };
});

const origin = 'https://panel.example.test:8443';
const installerOrigin='https://gateway.example.test:9443';
const capabilities = ['durable-completions', 'managed-installations', 'install-set-v1', 'workspace-instance-v1'];
function device(): IBridgeDevice {
    return { id: 'computer', name: 'Рабочий компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: { bridgeVersion: '0.9.4', protocolVersion: 2, capabilities: [...capabilities] } };
}
function select(devices: IBridgeDevice[], selected = devices[0]): void {
    fixture.bridge.devices = devices; fixture.bridge.device = selected;
}
const setup = (windows = false, projectId?: string): string => renderToStaticMarkup(createElement(BridgeSetup, { origin,installer:{origin:installerOrigin,loading:false,error:'',reload:vi.fn()}, windows, onCopy: vi.fn(), projectId }));

beforeEach(() => {
    vi.clearAllMocks(); fixture.buttons.clear();
    fixture.search = ''; fixture.connectAnother = undefined;
    fixture.bridge = { devices: [], device: undefined, jobs: [], installations: [], error: '',
        devicesReady: true, jobsReady: true, installationsReady: true, loading: false,
        errors: { devices: '', jobs: '', installations: '' }, reload: vi.fn(async () => undefined), choose: vi.fn() };
});

describe('Подключение компьютера с уже установленным мостом', () => {
    it('Подключение из списка сразу раскрывает команды, даже если выбранный компьютер уже на связи', () => {
        select([device()]);
        expect(setup()).not.toContain('--connect-open');
        expect(fixture.connectAnother).toBeDefined();
        fixture.connectAnother?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/start?step=1&addComputer=1');
        fixture.search = new URL(fixture.push.mock.calls[0][0], origin).search;
        expect(new URLSearchParams(fixture.search).has('connect')).toBe(false);
        const html = setup();
        expect(html).toContain('--connect-open');
        expect(html).toContain('Копировать команду подключения');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
    });

    it('Выбранный проект после настройки общей папки открывает свой мастер привязки', () => {
        const current = device(); current.report.root = '/fixture/projects'; select([current]); setup(false, 'prj-dossier-ko');
        fixture.buttons.get('Связать папку проекта')?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects?bind=prj-dossier-ko');
    });

    it('Без общей папки выбранный проект сначала ведёт к выбору корня', () => {
        select([device()]); setup(false, 'prj-dossier-ko');
        fixture.buttons.get('Выбрать папку проектов')?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects');
    });

    it('Без выбранного проекта настроенный компьютер открывает общий список', () => {
        const current = device(); current.report.root = '/fixture/projects'; select([current]); setup();
        fixture.buttons.get('Связать папку проекта')?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects');
    });

    it('Пустой список по умолчанию предлагает существующий мост и отдельный вариант установки', () => {
        const html = setup();
        expect(html).toContain('Мост уже установлен');
        expect(html).toContain('Установить мост');
        expect(html).toContain('--reconnect-open');
        expect(html).toContain('Копировать команду подключения');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
    });

    it('Копирование передаёт точную команду для текущей площадки и явного переподключения', () => {
        const onCopy = vi.fn();
        const html = renderToStaticMarkup(createElement(InstalledBridgeConnect, { origin, windows: false, reconnect: true, onCopy }));
        expect(html).toContain('--reconnect-open');
        expect(html).toMatch(/подтверд[а-яё]*.*(?:браузер|компьютер)|(?:браузер|компьютер).*подтверд/iu);
        fixture.buttons.get('Копировать команду подключения')?.onClick?.();
        expect(onCopy).toHaveBeenCalledExactlyOnceWith(installedBridgeCommand(origin, false, true));
    });

    it('Подключённый актуальный мост сразу разрешает переход к папкам', () => {
        select([device()]); const html = setup();
        expect(html).toContain('Рабочий компьютер · мост на связи');
        expect(html).toContain('Мост работает в фоне. Перейдите к папке проекта.');
        expect(fixture.buttons.get('Выбрать папку проектов')?.disabled).toBe(false);
        expect(html).toContain('Подключение и обновление моста');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
    });

    it('Истёкшее подключение предлагает подтверждение существующего моста без обновления файлов', () => {
        select([{ ...device(), requiresReconnect: true }]); const html = setup();
        expect(html).toMatch(/продлить|ист[её]к/iu);
        expect(html).toContain('--reconnect-open');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
        expect(fixture.buttons.get('Выбрать папку проектов')?.disabled).toBe(true);
    });

    it('Роль наблюдателя объясняет права и предлагает новое подтверждение без переустановки', () => {
        select([{ ...device(), role: 'Наблюдатель' }]); const html = setup();
        expect(html).toMatch(/роль|права/iu);
        expect(html).toContain('--reconnect-open');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
        expect(fixture.buttons.get('Выбрать папку проектов')?.disabled).toBe(true);
    });

    it('Недоступный компьютер запускается из существующей установки, а переход к папкам ждёт связи', () => {
        select([{ ...device(), online: false }]); const html = setup();
        expect(html).toMatch(/не отвечает|не в сети|Включите компьютер/iu);
        expect(html).toContain('--connect-open');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
        expect(fixture.buttons.get('Выбрать папку проектов')?.disabled).toBe(true);
    });

    it('При нескольких компьютерах без выбора не выдаёт один из них за текущий', () => {
        const first = device(); const second = { ...device(), id: 'other', name: 'Другой компьютер' };
        select([first, second]); fixture.bridge.device = undefined;
        const html = setup();
        expect(html).toContain('Выберите компьютер');
        expect(html).not.toContain('Рабочий компьютер — на связи');
        expect(fixture.buttons.get('Выбрать папку проектов')?.disabled).toBe(true);
    });

    it('Ошибка загрузки устройств сохраняет повтор проверки вместо ложного отсутствия установки', () => {
        fixture.bridge.devicesReady = false; fixture.bridge.errors.devices = 'Не удалось загрузить компьютеры';
        const html = setup();
        expect(html).toContain('Не удалось загрузить компьютеры');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
        expect(html).not.toContain('--connect-open');
    });

    it('Устаревшие возможности требуют обновления и показывают действующий установщик', () => {
        const old = device(); old.report.capabilities = ['durable-completions', 'managed-installations'];
        select([old]); const html = setup();
        expect(html).toMatch(/Обновите.*мост/iu);
        expect(html).toContain(installerOrigin+'/api/bridge/install.sh');
        expect(html).not.toContain(origin+'/api/bridge/install.sh');
    });

    it('Ручной код подходит для отдельного подключения и не требует предшествующей установки', () => {
        const html = renderToStaticMarkup(createElement(PairingCode));
        expect(html).toContain('код');
        expect(html).toContain('подтвердите доступ');
        expect(html).not.toContain('после установки');
    });

    it('Windows из отчёта компьютера имеет приоритет над macOS браузера', () => {
        const windows = device(); windows.online = false; windows.report.platform = 'win32';
        select([windows]); const html = setup(false);
        expect(html).toContain('aria-label="Система компьютера"');
        expect(html).toContain('node.exe');
        expect(html).not.toContain('/bin/node&quot;');
    });

    it('macOS из отчёта компьютера имеет приоритет над Windows браузера', () => {
        const mac = device(); mac.online = false; mac.report.platform = 'darwin';
        select([mac]); const html = setup(true);
        expect(html).toContain('aria-label="Система компьютера"');
        expect(html).toContain('/bin/node');
        expect(html).not.toContain('node.exe');
    });

    it('Без подключённых компьютеров Windows браузера выбирает PowerShell', () => {
        const html = setup(true);
        expect(html).toContain('node.exe');
        expect(html).toContain('--reconnect-open');
        expect(html).not.toMatch(/\/api\/bridge\/install\.(?:sh|ps1)/);
    });
});
