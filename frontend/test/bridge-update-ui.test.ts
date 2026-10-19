import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeConnection } from '../src/features/McpBridge/BridgeConnection';
import { BridgeSetup } from '../src/modules/Start/BridgeSetup';

const fixture = vi.hoisted(() => {
    const device = { id: 'computer', name: 'Компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: { bridgeVersion: '0.9.0', protocolVersion: 2,
            capabilities: ['durable-completions', 'managed-installations', 'install-set-v1', 'workspace-instance-v1'] } };
    return { bridge: { device, devices: [device], devicesReady: true, jobsReady: true, installationsReady: true,
        jobs: [], installations: [], error: '', loading: false, errors: { devices: '', jobs: '', installations: '' },
        choose: vi.fn(), reload: vi.fn(async () => undefined) } };
});
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => fixture.bridge }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn(), location: { pathname: '/start' } }) }));

const capabilities = [...fixture.bridge.device.report.capabilities];
const setup = () => renderToStaticMarkup(createElement(BridgeSetup, { command: 'fixture-installer', onCopy: vi.fn() }));
beforeEach(() => {
    fixture.bridge.device.report.bridgeVersion = '0.9.0';
    fixture.bridge.device.report.capabilities = [...capabilities];
});

describe('Обновление уже подключённого моста', () => {
    it('Показывает сообщённую компьютером версию, даже когда протокол совместим', () => {
        const html = renderToStaticMarkup(createElement(BridgeConnection, { bridge: fixture.bridge, compact: true }));
        expect(html).toContain('версия моста: 0.9.0');
    });
    it('Не подменяет отсутствующую версию текущей версией исходников', () => {
        fixture.bridge.device.report.bridgeVersion = '';
        const html = renderToStaticMarkup(createElement(BridgeConnection, { bridge: fixture.bridge, compact: true }));
        expect(html).toContain('версия моста не передана');
    });
    it('Совместимому компьютеру явно предлагает обновление через текущий установщик', () => {
        const html = setup();
        const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes('Обновить мост'));
        expect(button).toBeDefined();
        expect(button?.[1]).not.toContain('disabled');
        expect(html).toContain('Установить или обновить мост');
        expect(html).not.toContain('Подключить другой компьютер');
    });
    it('При обновлении объясняет сохранение подключения и повторную проверку версии', () => {
        fixture.bridge.device.report.capabilities = ['durable-completions', 'managed-installations'];
        const html = setup();
        expect(html).toContain('fixture-installer');
        expect(html).toContain('Сохранённое подключение будет использовано повторно');
        expect(html).toContain('Перезапустите OpenCode');
        expect(html).not.toContain('Следующий шаг — подтвердить компьютер');
        expect(html).not.toContain('Установщик сам откроет страницу подтверждения');
    });
});
