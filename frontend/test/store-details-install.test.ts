import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StoreDetailsInstallStatus, { StoreDetailsInstallButton } from '../src/modules/Store/StoreDetailsInstall';
import { installStatusView } from '../src/modules/Store/storeDetails';

describe('Установка из карточки инструмента', () => {
    it('Скрывает действие без разрешённого callback даже при наличии статуса', () => {
        expect(renderToStaticMarkup(createElement(StoreDetailsInstallButton, { status: { state: 'failed' } }))).toBe('');
    });

    it('Предлагает установку только при переданном действии', () => {
        const html = renderToStaticMarkup(createElement(StoreDetailsInstallButton, { onInstall: () => undefined }));
        expect(html).toContain('Установить на компьютер');
        expect(html).not.toContain('disabled=""');
    });

    it('Не выдумывает статус до отправки запроса', () => {
        expect(renderToStaticMarkup(createElement(StoreDetailsInstallStatus, {}))).toBe('');
        expect(installStatusView().title).toBeNull();
    });

    it('Блокирует повторный запуск во время отправки', () => {
        const view = installStatusView(undefined, true);
        expect(view.busy).toBe(true);
        expect(view.disabled).toBe(true);
        expect(view.title).toContain('Отправляем запрос');
        expect(view.percent).toBeUndefined();
    });

    it.each(['queued', 'running', 'reconciling'])('Блокирует повторный запуск активного задания: %s', state => {
        const view = installStatusView({ state });
        expect(view.busy).toBe(true);
        expect(view.disabled).toBe(true);
        const html = renderToStaticMarkup(createElement(StoreDetailsInstallButton, { status: { state }, onInstall: () => undefined }));
        expect(html).toContain('disabled=""');
    });

    it.each(['failed', 'cancelled'])('Разрешает повтор завершённой неуспешной установки: %s', state => {
        const view = installStatusView({ state });
        expect(view.disabled).toBe(false);
        expect(view.busy).toBe(false);
        expect(view.buttonLabel).toBe('Повторить установку');
    });

    it('Показывает завершение задания и не обещает работающий MCP', () => {
        const view = installStatusView({ state: 'succeeded' });
        expect(view.title).toBe('Файлы установлены; запуск ещё не проверен');
        expect(view.disabled).toBe(true);
        expect(view.percent).toBeUndefined();
    });

    it('Не рисует процент без подтверждённого значения', () => {
        const html = renderToStaticMarkup(createElement(StoreDetailsInstallStatus, { status: { state: 'running', message: 'Подготавливаем файлы' } }));
        expect(html).toContain('Установка выполняется');
        expect(html).toContain('Подготавливаем файлы');
        expect(html).not.toContain('role="progressbar"');
    });

    it('Показывает фактический процент в тексте и для экранного диктора', () => {
        const html = renderToStaticMarkup(createElement(StoreDetailsInstallStatus, { status: { state: 'running', percent: 62, message: 'Копируем файлы' } }));
        expect(html).toContain('62%');
        expect(html).toContain('aria-valuenow="62"');
        expect(html).toContain('Копируем файлы');
    });

    it('Ограничивает неверный процент и пропускает нечисловые значения', () => {
        expect(installStatusView({ state: 'running', percent: -4 }).percent).toBe(0);
        expect(installStatusView({ state: 'running', percent: 140 }).percent).toBe(100);
        expect(installStatusView({ state: 'running', percent: 42.6 }).percent).toBe(43);
        expect(installStatusView({ state: 'running', percent: Number.NaN }).percent).toBeUndefined();
        expect(installStatusView({ state: 'running', percent: Number.POSITIVE_INFINITY }).percent).toBeUndefined();
    });

    it.each(['', 'unknown', '__proto__', 'constructor'])('Не запускает новое задание при неизвестном состоянии: %s', state => {
        const view = installStatusView({ state });
        expect(view.title).toBe('Статус установки уточняется');
        expect(view.disabled).toBe(true);
        expect(view.busy).toBe(false);
    });
});
