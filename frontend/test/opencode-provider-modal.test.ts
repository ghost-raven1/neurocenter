import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProviderSetupModal, type IProviderSetupModalProps} from '../src/features/OpenCodeProviders/ProviderSetupModal';
import {useCodexSupply} from '../src/features/OpenCodeProviders/useCodexSupply';
import {useProviderSetup} from '../src/features/OpenCodeProviders/useProviderSetup';
import {adminSetupHooks} from './admin-setup-hooks.fixture';
import {bridgeFixture, configured, model, preparation, selection} from './opencode-provider.fixture';

const ui = vi.hoisted(() => ({general: true, codex: true, buttons: new Map<string, {disabled?: boolean; onClick?: () => void}>(),
    selects: new Map<string, {onChange: (value: string) => void; disabled?: boolean}>(), close: undefined as (() => void) | undefined}));
let hooks = adminSetupHooks();
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: (initial: unknown) => hooks.state(initial)}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: (key: string) => ({enabled: key === 'codex_connector' ? ui.codex : ui.general, reason: 'Функция выключена', refresh: vi.fn(async () => undefined)})}));
vi.mock('../src/features/OpenCodeProviders/useCodexSupply', () => ({useCodexSupply: vi.fn()}));
vi.mock('../src/features/OpenCodeProviders/useProviderSetup', () => ({useProviderSetup: vi.fn()}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Space: content, Tag: content, Typography: {Text: content, Paragraph: content}, Steps: () => null,
        Modal: ({children, title, onCancel}: {children?: ReactNode; title: string; onCancel(): void}) => {ui.close = onCancel; return createElement('div', null, title, children);},
        Button: (props: {children?: ReactNode; disabled?: boolean; href?: string; onClick?: () => void}) => {ui.buttons.set(String(props.children), props); return createElement(props.href ? 'a' : 'button', {disabled: props.disabled, href: props.href}, props.children);},
        Select: (props: {'aria-label': string; onChange: (value: string) => void; disabled?: boolean}) => {ui.selects.set(props['aria-label'], props); return null;},
        Alert: ({message, description, action}: {message: ReactNode; description?: ReactNode; action?: ReactNode}) => createElement('div', null, message, description, action)};
});
let supply: ReturnType<typeof useCodexSupply>;
let operation: ReturnType<typeof useProviderSetup>;
let props: IProviderSetupModalProps;
function render() {hooks.begin(); ui.buttons.clear(); ui.selects.clear(); return renderToStaticMarkup(createElement(ProviderSetupModal, props));}
function click(label: string) {const button = ui.buttons.get(label); expect(button).toBeDefined(); expect(button!.disabled).not.toBe(true); button!.onClick?.();}
beforeEach(() => {
    hooks = adminSetupHooks(); ui.general = true; ui.codex = true;
    operation = {job: undefined, preparation: undefined, opened: undefined, status: undefined, busy: false, pending: false, error: '', unknown: false, retryRequiresWrite: true,
        open: vi.fn(), check: vi.fn(), retry: vi.fn(), reload: vi.fn()};
    supply = {scope: 'owner', supply: {state: 'ready', targets: ['darwin-arm64']}, error: '', busy: false, unknown: false, build: vi.fn(), reload: vi.fn()};
    vi.mocked(useCodexSupply).mockImplementation(() => supply);
    vi.mocked(useProviderSetup).mockImplementation(() => operation);
    props = {projectId: selection.projectId, projectName: 'Рабочий проект', bridge: bridgeFixture(), models: [model], initialModelId: model.id,
        canManage: true, catalogReady: true, onClose: vi.fn(), onReloadModels: vi.fn(), onConfigured: vi.fn()};
});
afterEach(() => hooks.dispose());

describe('One local provider setup dialog', () => {
    it('Shows named project/computer and one primary local action with no website secret form', () => {
        const html = render(); expect(html).toContain('Рабочий проект'); expect(html).toContain('папка-проекта'); expect(html).toContain('ключ с сервера не переносится');
        expect(html).not.toContain('type="password"'); expect(html).not.toContain('private-provider.example');
        click('Открыть настройку на компьютере'); expect(operation.open).toHaveBeenCalledOnce();
        expect(vi.mocked(useProviderSetup).mock.calls[vi.mocked(useProviderSetup).mock.calls.length - 1][0]).toMatchObject({selection, canRead: true, canWrite: true});
    });
    it('Feature OFF blocks a new wizard while preserving readiness and recovery', () => {
        ui.general = false; render(); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true); click('Проверить готовность'); click('Перечитать очередь');
        expect(operation.check).toHaveBeenCalledOnce(); expect(operation.reload).toHaveBeenCalledOnce(); expect(vi.mocked(useProviderSetup).mock.calls[vi.mocked(useProviderSetup).mock.calls.length - 1][0]).toMatchObject({canRead: true, canWrite: false});
    });
    it('OFF lets an uncertain status request be retried, but not a write', () => {
        ui.general = false; operation.unknown = true; render(); expect(ui.buttons.get('Повторить запрос')!.disabled).toBe(true);
        operation.retryRequiresWrite = false; render(); click('Повторить запрос'); expect(operation.retry).toHaveBeenCalledOnce();
    });
    it('Codex has a separate flag and no catalog dependency or API-key form', () => {
        props.models = []; props.catalogReady = false; render(); ui.selects.get('Тип провайдера OpenCode')!.onChange('codex-bridge'); const html = render();
        expect(html).toContain('официальный экран'); expect(html).toContain('API-ключ для Codex не требуется'); expect(vi.mocked(useProviderSetup).mock.calls[vi.mocked(useProviderSetup).mock.calls.length - 1][0].canRead).toBe(true);
        ui.codex = false; render(); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true); expect(ui.buttons.get('Проверить готовность')!.disabled).toBe(false);
    });
    it('API selection requires a current assigned verified model; failure has refresh action', () => {
        props.catalogReady = false; props.catalogError = 'Каталог не загрузился'; const html = render(); expect(html).toContain('Каталог не загрузился');
        expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true); click('Обновить модели'); expect(props.onReloadModels).toHaveBeenCalledOnce();
        props.catalogReady = true; props.catalogError = ''; render(); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(false);
    });
    it.each(['missing', 'viewer', 'instance', 'queue'])('Invalid %s computer context does not allow local or status jobs', mode => {
        if (mode === 'missing') props.bridge.device = undefined;
        if (mode === 'viewer') props.bridge.device!.role = 'Наблюдатель';
        if (mode === 'instance') props.bridge.device!.report.bindings![0].instanceId = '';
        if (mode === 'queue') props.bridge.jobsReady = false;
        render(); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true); expect(ui.buttons.get('Проверить готовность')!.disabled).toBe(true);
    });
    it('Offline queue is explicit, pending disables repeated opening and choosing a different target', () => {
        props.bridge.device!.online = false; operation.pending = true; const html = render(); expect(html).toContain('Компьютер не в сети'); expect(html).toContain('Запрос останется в очереди');
        expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true); expect(ui.selects.get('Компьютер для провайдера OpenCode')!.disabled).toBe(true);
        click('Перечитать очередь'); expect(operation.reload).toHaveBeenCalledOnce();
    });
    it('API config readiness offers a return without promising all project agents can be applied', () => {
        operation.opened = {...preparation(), opened: true}; let html = render(); expect(html).toContain('Локальный мастер открыт'); expect(ui.buttons.has('Вернуться к агентам')).toBe(false);
        operation.status = configured() as NonNullable<typeof operation.status>; html = render();
        expect(html).toContain('Провайдер настроен'); expect(html).not.toContain('Можно применить настройки агентов');
        const details = html.indexOf('<details>'); expect(html.indexOf('выбранную каталожную модель')).toBeGreaterThan(details);
        click('Вернуться к агентам'); expect(props.onConfigured).toHaveBeenCalledOnce();
    });
    it('Codex config readiness points to a new native OpenCode session, not agent application', () => {
        render(); ui.selects.get('Тип провайдера OpenCode')!.onChange('codex-bridge');
        operation.status = {...configured(), providerKind: 'codex-bridge', providerId: 'neurocenter-codex-0123456789abcdef', catalogModelId: null, modelPin: null,
            connector: {assetId: 'ai-plug-codex', version: 1, manifest: 'e'.repeat(64), sourceCommit: 'f'.repeat(40)}} as NonNullable<typeof operation.status>;
        const html = render(); expect(html).toContain('Модель настроена в OpenCode'); expect(html).toContain('новую сессию OpenCode');
        expect(html).not.toContain('Можно применить настройки агентов'); expect(html).not.toContain('Применить настройки'); expect(ui.buttons.has('Вернуться к агентам')).toBe(false);
        expect(props.onConfigured).not.toHaveBeenCalled();
    });
    it('Main admin gets one guarded primary prepare action only when the fixed supply is missing', () => {
        props.canPrepareConnector = true; render(); ui.selects.get('Тип провайдера OpenCode')!.onChange('codex-bridge'); supply.supply = {state: 'missing'}; render();
        expect(ui.buttons.has('Открыть настройку на компьютере')).toBe(false); click('Подготовить коннектор Codex'); expect(supply.build).toHaveBeenCalledOnce(); expect(operation.open).not.toHaveBeenCalled();
        supply.supply = {state: 'ready', targets: ['darwin-arm64']}; render(); click('Открыть настройку на компьютере'); expect(operation.open).toHaveBeenCalledOnce();
    });
    it('A building/conflicting supply never starts another build; read recovery stays available', () => {
        props.canPrepareConnector = true; render(); ui.selects.get('Тип провайдера OpenCode')!.onChange('codex-bridge');
        supply.supply = {state: 'building'}; render(); expect(ui.buttons.get('Подготавливаем коннектор Codex')!.disabled).toBe(true); click('Обновить поставку Codex');
        supply.supply = {state: 'conflict'}; const html = render(); expect(html).toContain('новая сборка не отправлена'); expect(ui.buttons.get('Проверить поставку Codex')!.disabled).toBe(true); expect(supply.build).not.toHaveBeenCalled();
    });
    it('Unknown or different exact runtime target never opens a Codex wizard', () => {
        props.canPrepareConnector = true; render(); ui.selects.get('Тип провайдера OpenCode')!.onChange('codex-bridge'); supply.supply = {state: 'ready', targets: ['linux-x64-musl']};
        expect(render()).toContain('нет готового коннектора'); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true);
        props.bridge.device!.report.runtimeArtifactTarget = undefined; expect(render()).toContain('Платформа компьютера не подтверждена'); expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true);
    });
    it('Empty API models offer a direct existing project Models handoff, not an endless reload', () => {
        props.models = []; const html = render(); expect(html).toContain('href="/projects/prj-test?tab=store&amp;catalogTab=models"'); expect(html).toContain('Открыть модели проекта');
        expect(operation.open).not.toHaveBeenCalled();
    });
    it('A server-valid long model ID has an explicit local compatibility hint and no setup request', () => {
        props.models = [{...model, model: 'a'.repeat(129)}]; const html = render();
        expect(html).toContain('до 128 символов'); expect(html).toContain('модель остаётся доступна через серверное API');
        expect(ui.buttons.get('Открыть настройку на компьютере')!.disabled).toBe(true);
        const last = vi.mocked(useProviderSetup).mock.calls[vi.mocked(useProviderSetup).mock.calls.length - 1][0]; expect(last.selection).toBeUndefined();
        expect(html).toContain('Открыть модели проекта'); expect(operation.open).not.toHaveBeenCalled();
    });
    it('Unsupported old bridge has a direct repair route', () => {
        props.bridge.device!.report.capabilities = []; const html = render(); expect(html).toContain('href="/start?step=1"'); expect(html).toContain('Настроить мост');
    });
    it('Queue and technical server/local details are secondary to the primary action', () => {
        const html = render(), details = html.indexOf('<details>'); expect(details).toBeGreaterThan(0);
        expect(html.indexOf('Перечитать очередь')).toBeGreaterThan(details); expect(html.indexOf('ключ с сервера не переносится')).toBeGreaterThan(details);
        expect(html.indexOf('Открыть настройку на компьютере')).toBeLessThan(details);
    });
    it('Closing or reselecting uses existing callbacks without a hidden side effect', () => {
        props.bridge.choose = vi.fn(); render(); ui.selects.get('Компьютер для провайдера OpenCode')!.onChange('other-device'); ui.close!();
        expect(props.bridge.choose).toHaveBeenCalledExactlyOnceWith('other-device'); expect(props.onClose).toHaveBeenCalledOnce(); expect(operation.open).not.toHaveBeenCalled();
    });
});
