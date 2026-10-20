import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice } from '../src/features/McpBridge/api';
import type { useBridge } from '../src/features/McpBridge/useBridge';
import { BridgeConnection } from '../src/features/McpBridge/BridgeConnection';
import { BridgeDeviceDetails } from '../src/features/McpBridge/BridgeDeviceDetails';

vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn(), location: { pathname: '/projects' } }) }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: 'fixture', captureOwner: () => () => true }) }));

function fixture(): ReturnType<typeof useBridge> {
    const device: IBridgeDevice = { id: 'computer', name: 'Мой компьютер', role: 'Разработчик', fingerprint: 'fixture',
        online: true, lastSeen: '2026-10-19T03:00:00.000Z', report: { root: '/fixture/projects', bridgeVersion: '0.9.4',
            protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'install-set-v1', 'workspace-instance-v1'] } };
    return { device, devices: [device], jobs: [], installations: [], error: '', loading: false,
        devicesReady: true, jobsReady: true, installationsReady: true, errors: { devices: '', jobs: '', installations: '' },
        choose: vi.fn(), reload: vi.fn(async () => undefined) };
}
let bridge: ReturnType<typeof useBridge>;
const render = (compact = false): string => renderToStaticMarkup(createElement(BridgeConnection, { bridge, compact }));
const details = (): string => renderToStaticMarkup(createElement(BridgeDeviceDetails, { device: bridge.device! }));
beforeEach(() => { bridge = fixture(); });

describe('Статус и последний ответ выбранного моста', () => {
    it('Ошибка обновления скрывает прежний онлайн-статус и сохраняет имя, а папка остаётся в сведениях', () => {
        bridge.devicesReady = false; bridge.errors.devices = 'Не удалось загрузить список компьютеров';
        const html = render();
        expect(html).toContain('Мой компьютер · статус не проверен');
        expect(html).not.toContain('мост на связи');
        expect(html).not.toContain('/fixture/projects');
        expect(details()).toContain('/fixture/projects');
        expect(html).toContain(bridge.errors.devices);
    });

    it('Непроверенный снимок не обещает доступность даже до появления ошибки чтения', () => {
        bridge.devicesReady = false;
        expect(render()).toContain('Мой компьютер · статус не проверен');
    });

    it('Не выдаёт неизвестное состояние за подтверждённое отключение моста', () => {
        bridge.devicesReady = false; bridge.device!.online = false;
        const html = render();
        expect(html).toContain('статус не проверен');
        expect(html).not.toContain('мост не в сети');
        expect(html).not.toContain('Включите компьютер');
        expect(html).not.toContain('задания останутся в очереди до подключения');
    });

    it('Ошибка списка имеет приоритет над сохранённым признаком готовности', () => {
        bridge.errors.devices = 'Сервер временно недоступен';
        expect(render()).not.toContain('мост на связи');
    });

    it.each([true, false])('Проверенный снимок online=%s явно описывает мост', online => {
        bridge.device!.online = online;
        expect(render()).toContain(`Мой компьютер · мост ${online ? 'на связи' : 'не в сети'}`);
    });

    it.each([
        { verified: true, online: true, status: 'мост на связи' },
        { verified: true, online: false, status: 'мост не в сети' },
        { verified: false, online: true, status: 'статус не проверен' },
    ])('Длинное имя не объединяется со статусом «$status» в обрезаемый текст', ({ verified, online, status }) => {
        bridge.device!.name = 'MacBook-Pro-Aleksej.local-с-длинным-именем';
        bridge.device!.online = online; bridge.devicesReady = verified;
        const html = render(true);
        expect(html).toContain(`<span class="bridge-connection__device-status">${status}</span>`);
        expect(html).toContain('class="bridge-connection__device-name"');
    });

    it('Последний ответ содержит читаемое время и машинную ISO-дату', () => {
        const html = details();
        expect(html).toContain('Последний ответ моста:');
        expect(html).toContain('<time dateTime="2026-10-19T03:00:00.000Z">');
        expect(html).toMatch(/<time dateTime="[^"]+">\d{2}\.\d{2}\.2026,\s*\d{2}:\d{2}:\d{2}<\/time>/);
    });

    it.each([null, '', 'invalid date'])('Не выводит повреждённое время последнего ответа %s', value => {
        bridge.device!.lastSeen = value;
        const html = details();
        expect(html).toContain('Ответов моста ещё нет');
        expect(html).not.toContain('<time');
        expect(html).not.toContain('Invalid Date');
    });

    it('Технические сведения не перегружают компактный блок и доступны из списка компьютеров', () => {
        const compact = render(true);
        expect(compact).not.toContain('Фоновый мост работает');
        expect(compact).not.toContain('Последний ответ моста:');
        expect(compact).not.toContain('0.9.4');
        expect(compact).not.toContain('/fixture/projects');
        expect(compact).toContain('Мои компьютеры (1)');
    });
});
