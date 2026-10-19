import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeRagUi } from '../src/features/McpBridge/ragUi/OpenCodeRagUi';
import { ragUiFixture } from './ragUiFixture';

const ui = vi.hoisted(() => ({ hook: vi.fn(), submit: vi.fn(), buttons: [] as Array<Record<string, any>> }));
vi.mock('../src/features/McpBridge/ragUi/useRagUiLauncher', () => ({ useRagUiLauncher: (...args: unknown[]) => ui.hook(...args) }));
vi.mock('antd', async original => ({ ...await original<typeof import('antd')>(),
    Button: (props: Record<string, any>) => {
        ui.buttons.push(props);
        return createElement(props.href ? 'a' : 'button', { disabled: props.disabled, href: props.href }, props.children);
    },
}));
beforeEach(() => {
    vi.clearAllMocks(); ui.buttons = [];
    ui.hook.mockReturnValue({ busy: false, error: '', submit: ui.submit });
    ui.submit.mockResolvedValue(undefined);
});
function render(bridge = ragUiFixture().bridge, canWrite = true) {
    return renderToStaticMarkup(createElement(OpenCodeRagUi, { bridge, projectId: 'prj-one', canWrite }));
}
const openButton = () => ui.buttons.find(button => typeof button.onClick === 'function' && String(button.children).includes('открытие'))
    ?? ui.buttons.find(button => String(button.children).startsWith('Открыть OpenCodeRAG'))!;

describe('Открытие локального интерфейса OpenCodeRAG', () => {
    it('Использует выбранный мост и папку, отправляет запрос только после нажатия', () => {
        const f = ragUiFixture(), html = render(f.bridge);
        expect(html).toContain('отдельное окно браузера на компьютере моста');
        expect(ui.hook.mock.calls[0][1]).toBe(f.bridge); expect(ui.submit).not.toHaveBeenCalled();
        const button = openButton(); expect(button.disabled).toBe(false); button.onClick();
        expect(ui.submit).toHaveBeenCalledExactlyOnceWith({ kind: 'open-rag-ui', deviceId: f.device.id, projectId: f.binding.projectId,
            assetId: f.item.assetId, assetKind: 'mcp', version: 3, expectedManifest: f.item.manifest,
            expectedBindingId: f.binding.bindingId, expectedInstanceId: f.binding.instanceId });
    });
    it('Старая установка показывает путь обновления инструмента в текущем проекте', () => {
        const f = ragUiFixture(); f.bridge.installations = [{ ...f.item, ragUi: undefined }];
        const html = render(f.bridge); expect(openButton().disabled).toBe(true);
        expect(html).toContain('Установите или обновите OpenCodeRAG'); expect(html).toContain('/store?p=prj-one&amp;q=OpenCodeRAG');
        openButton().onClick(); expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Старый мост предлагает обновление, без установки дубликата инструмента', () => {
        const f = ragUiFixture(); f.device.report.capabilities = ['durable-completions', 'managed-installations'];
        const html = render(f.bridge); expect(openButton().disabled).toBe(true); expect(html).toContain('0.9.5');
        expect(html).toContain('Обновить мост'); expect(html).not.toContain('/store?');
    });
    it.each(['offline', 'observer', 'stale-device'] as const)('Недоступное состояние %s не отправляет действие', reason => {
        const f = ragUiFixture(); if (reason === 'offline') f.device.online = false;
        if (reason === 'stale-device') f.bridge.devicesReady = false;
        render(f.bridge, reason !== 'observer'); expect(openButton().disabled).toBe(true);
        openButton().onClick(); expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Несколько поддерживаемых пакетов требуют явного выбора вместо скрытого первого', () => {
        const f = ragUiFixture(); f.bridge.installations = [f.item, { ...f.item, assetId: 'rag-plugin', assetKind: 'plugin', name: 'OpenCodeRAG Plugin' }];
        const html = render(f.bridge); expect(html).toContain('Установка OpenCodeRAG для открытия');
        expect(html).toContain('Выберите установленный пакет OpenCodeRAG'); expect(openButton().disabled).toBe(true);
        expect(html).not.toContain('Установите или обновите'); expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Показывает подтверждённый прогресс задания и блокирует повторное нажатие', () => {
        const f = ragUiFixture(); f.bridge.jobs = [f.job({ state: 'running', percent: 35, message: 'Запускаем сервер интерфейса' })];
        const html = render(f.bridge); expect(html).toContain('Запускаем сервер интерфейса'); expect(html).toContain('35%');
        expect(openButton().disabled).toBe(true); openButton().onClick(); expect(ui.submit).not.toHaveBeenCalled();
        expect(html).not.toContain('открыт на компьютере моста');
    });
    it('Очередь POST видна до перечитывания списка, принятие не объявляется открытым окном', () => {
        const f = ragUiFixture(); ui.hook.mockReturnValue({ busy: false, error: '', submitted: f.job(), submit: ui.submit });
        const html = render(f.bridge); expect(html).toContain('Открываем окно'); expect(openButton().disabled).toBe(true);
        expect(html).not.toContain('Интерфейс OpenCodeRAG открыт');
    });
    it('Показывает результат только после opened, отказ содержит причину и повтор', () => {
        const f = ragUiFixture(); f.bridge.jobs = [f.job({ state: 'succeeded', result: { opened: true, reused: false, note: 'Открыто на выбранном компьютере' } })];
        expect(render(f.bridge)).toContain('Интерфейс OpenCodeRAG открыт на компьютере моста');
        f.bridge.jobs = [f.job({ state: 'failed', message: 'Не удалось запустить браузер на компьютере моста' })]; ui.buttons = [];
        const failed = render(f.bridge); expect(failed).toContain('Не удалось запустить браузер');
        expect(openButton().children).toBe('Повторить открытие OpenCodeRAG'); expect(openButton().disabled).toBe(false);
    });
    it('Успешное задание без подтверждения и история другой папки не изображают открытое окно', () => {
        const f = ragUiFixture(); f.bridge.jobs = [f.job({ state: 'succeeded', result: {} })];
        expect(render(f.bridge)).toContain('Открытие окна не подтверждено');
        f.bridge.jobs = [f.job({ bindingId: 'old-folder', state: 'succeeded', result: { opened: true, reused: false, note: 'Старое окно' } })];
        expect(render(f.bridge)).not.toContain('Старое окно');
    });
    it('Отменённое ожидание сохраняет причину и разрешает повтор', () => {
        const f = ragUiFixture(); f.bridge.jobs = [f.job({ state: 'cancelled', message: 'Задание отменено пользователем' })];
        const html = render(f.bridge); expect(html).toContain('Открытие OpenCodeRAG отменено');
        expect(html).toContain('Задание отменено пользователем'); expect(openButton().disabled).toBe(false);
    });
    it('Ошибка неизвестного POST оставляет проверку тем же запросом и не сообщает успех', () => {
        ui.hook.mockReturnValue({ busy: false, error: 'Не удалось подтвердить запуск', submit: ui.submit });
        const html = render(); expect(html).toContain('Проверить и повторить открытие');
        expect(html).toContain('Обновить данные'); expect(html).not.toContain('Интерфейс OpenCodeRAG открыт');
    });
});
