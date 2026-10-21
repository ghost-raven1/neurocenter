import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeDeviceDetails } from '../src/features/McpBridge/BridgeDeviceDetails';
import { BridgeSetup } from '../src/modules/Start/BridgeSetup';
import type {IBridgeDevice} from '../src/features/McpBridge/api';

const fixture = vi.hoisted(() => {
    const device:IBridgeDevice = { id: 'computer', name: 'Компьютер', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: { bridgeVersion: '0.9.0', protocolVersion: 2,
            capabilities: ['durable-completions', 'managed-installations', 'install-set-v1', 'workspace-instance-v1'] } };
    return { bridge: { device, devices: [device], devicesReady: true, jobsReady: true, installationsReady: true,
        jobs: [], installations: [], error: '', loading: false, errors: { devices: '', jobs: '', installations: '' },
        choose: vi.fn(), reload: vi.fn(async () => undefined) } };
});
vi.mock('../src/features/McpBridge/useBridge', () => ({ useBridge: () => fixture.bridge }));
vi.mock('../src/features/McpBridge/BridgeSourcePanel', () => ({BridgeSourcePanel:()=>null}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: 'fixture', captureOwner: () => () => true }) }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn(), location: { pathname: '/start' } }) }));

const capabilities = [...(fixture.bridge.device.report.capabilities??[])];
const setup = () => renderToStaticMarkup(createElement(BridgeSetup, { origin: 'https://panel.example.test', installer:{origin:'https://gateway.example.test',loading:false,error:'',reload:vi.fn()}, windows: false, onCopy: vi.fn() }));
beforeEach(() => {
    fixture.bridge.device.online=true;fixture.bridge.device.lastSeen=null;
    fixture.bridge.device.report={bridgeVersion:'0.9.0',protocolVersion:2,capabilities:[...capabilities]};
});

describe('Обновление уже подключённого моста', () => {
    it('Новый offline-компьютер без heartbeat ожидает первый выход на связь, а не объявляется устаревшим',()=>{
        fixture.bridge.device.online=false;fixture.bridge.device.report={};
        const html=setup();expect(html).toContain('Ожидаем первого выхода на связь');expect(html).not.toContain('Обновите мост');
        expect(html).not.toContain('Для новых возможностей обновите программу');
    });
    it('Известный совместимый offline-мост не требует переустановки',()=>{
        fixture.bridge.device.online=false;fixture.bridge.device.lastSeen='2026-10-20T00:00:00Z';
        const html=setup();expect(html).toContain('сейчас не отвечает');expect(html).not.toContain('Обновите мост');
    });
    it('Известный старый offline-мост всё ещё получает явную рекомендацию обновления',()=>{
        fixture.bridge.device.online=false;fixture.bridge.device.lastSeen='2026-10-20T00:00:00Z';fixture.bridge.device.report={};
        expect(setup()).toContain('Обновите мост');
    });
    it('Показывает сообщённую компьютером версию, даже когда протокол совместим', () => {
        const html = renderToStaticMarkup(createElement(BridgeDeviceDetails, { device: fixture.bridge.device }));
        expect(html).toContain('версия моста: 0.9.0');
    });
    it('Не подменяет отсутствующую версию текущей версией исходников', () => {
        fixture.bridge.device.report.bridgeVersion = '';
        const html = renderToStaticMarkup(createElement(BridgeDeviceDetails, { device: fixture.bridge.device }));
        expect(html).toContain('версия моста не передана');
    });
    it('Совместимому компьютеру оставляет подключение и обновление в раскрываемом разделе', () => {
        const html = setup();
        const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes('Обновить мост'));
        expect(button).toBeUndefined();
        expect(html).toContain('Подключить другой компьютер или обновить мост');
        expect(html).toContain('Источник и версии моста');
        expect(html).not.toContain('Подключить установленный мост');
        expect([...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].some(match=>match[1].includes('Подключить другой компьютер'))).toBe(false);
    });
    it('При обновлении объясняет сохранение подключения и повторную проверку версии', () => {
        fixture.bridge.device.report.capabilities = ['durable-completions', 'managed-installations'];
        const html = setup();
        expect(html).toContain('/api/bridge/install.sh');
        expect(html).toContain('https://gateway.example.test/api/bridge/install.sh');
        expect(html).not.toContain('https://panel.example.test/api/bridge/install.sh');
        expect(html).toContain('Сохранённое подключение будет использовано повторно');
        expect(html).toContain('Перезапустите OpenCode');
        expect(html).not.toContain('Следующий шаг — подтвердить компьютер');
        expect(html).not.toContain('Установщик сам откроет страницу подтверждения');
    });
});
