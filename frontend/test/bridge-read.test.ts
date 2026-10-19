import { describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeInstallation } from '../src/features/McpBridge/api';
import { bridgeConnectionState, bridgeReadError, readBridgeResources } from '../src/features/McpBridge/bridgeRead';

const device: IBridgeDevice = { id: 'computer', name: 'Рабочий компьютер', role: 'Разработчик', fingerprint: 'test', online: true, lastSeen: null, report: {} };
const callbacks = () => ({ devices: vi.fn(), jobs: vi.fn(), installations: vi.fn() });

describe('Независимая загрузка подключения MCP', () => {
    it('Не теряет компьютер и задания при отказе списка установок', async () => {
        const receive = callbacks();
        await readBridgeResources({
            devices: async () => [device], jobs: async () => [],
            installations: async () => { throw { isAxiosError: true, response: { status: 403, data: { message: 'Активная роль не разрешает это действие в данном проекте.' } } }; },
        }, receive);
        expect(receive.devices).toHaveBeenCalledWith({ ok: true, data: [device] });
        expect(receive.jobs).toHaveBeenCalledWith({ ok: true, data: [] });
        expect(receive.installations).toHaveBeenCalledWith({ ok: false, accessDenied: true, error: 'Не удалось загрузить список установленных инструментов. Попробуйте обновить данные.' });
    });

    it('Передаёт список компьютеров сразу, не дожидаясь зависшего чтения установок', async () => {
        let finish!: (value: IBridgeInstallation[]) => void;
        const pending = new Promise<IBridgeInstallation[]>(resolve => { finish = resolve; });
        const receive = callbacks();
        const loading = readBridgeResources({ devices: async () => [device], jobs: async () => [], installations: () => pending }, receive);
        await Promise.resolve();
        expect(receive.devices).toHaveBeenCalledWith({ ok: true, data: [device] });
        expect(receive.installations).not.toHaveBeenCalled();
        finish([]);
        await loading;
        expect(receive.installations).toHaveBeenCalledWith({ ok: true, data: [] });
    });

    it('Сбой списка компьютеров не скрывает успешно прочитанные задания', async () => {
        const receive = callbacks();
        await readBridgeResources({ devices: async () => { throw new Error('Сеть недоступна'); }, jobs: async () => [], installations: async () => [] }, receive);
        expect(receive.devices).toHaveBeenCalledWith({ ok: false, error: 'Не удалось загрузить список компьютеров. Попробуйте обновить данные.' });
        expect(receive.jobs).toHaveBeenCalledWith({ ok: true, data: [] });
        expect(receive.installations).toHaveBeenCalledWith({ ok: true, data: [] });
    });

    it('Не принимает неполный ответ сервера за отсутствие устройств', async () => {
        const receive = callbacks();
        await readBridgeResources({ devices: async () => null as unknown as IBridgeDevice[], jobs: async () => [], installations: async () => [] }, receive);
        expect(receive.devices).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining('список компьютеров') });
        expect(receive.devices).not.toHaveBeenCalledWith({ ok: true, data: [] });
    });

    it('Различает ожидание, подтверждённое отсутствие и ошибку подключения', () => {
        expect(bridgeConnectionState(0, false, '')).toBe('loading');
        expect(bridgeConnectionState(0, true, '')).toBe('empty');
        expect(bridgeConnectionState(0, false, 'Не удалось загрузить')).toBe('error');
        expect(bridgeConnectionState(0, true, 'Не удалось обновить')).toBe('error');
    });

    it('Оставляет ранее прочитанный компьютер видимым при ошибке обновления', () => {
        expect(bridgeConnectionState(1, true, '')).toBe('connected');
        expect(bridgeConnectionState(1, false, 'Не удалось обновить')).toBe('connected');
    });

    it('Предлагает повторный вход при завершении сессии', () => {
        expect(bridgeReadError('devices', { isAxiosError: true, response: { status: 401 } })).toBe('Войдите в профиль снова, чтобы увидеть список компьютеров.');
    });

    it.each([401, 403, 404])('Отказ %s требует очистить прежние личные сведения', async status => {
        const receive = callbacks();
        await readBridgeResources({ devices: async () => { throw { isAxiosError: true, response: { status } }; }, jobs: async () => [], installations: async () => [] }, receive);
        expect(receive.devices).toHaveBeenCalledWith({ ok: false, accessDenied: true, error: expect.any(String) });
        expect(receive.jobs).toHaveBeenCalledWith({ ok: true, data: [] });
    });

    it('Временный 503 не требует удаления ранее полученных данных', async () => {
        const receive = callbacks();
        await readBridgeResources({ devices: async () => { throw { isAxiosError: true, response: { status: 503 } }; }, jobs: async () => [], installations: async () => [] }, receive);
        expect(receive.devices).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });
    });
});
