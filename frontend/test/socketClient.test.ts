import { beforeEach, describe, expect, it, vi } from 'vitest';
const raw = vi.hoisted(() => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
}));
const factory = vi.hoisted(() => vi.fn(() => raw));
vi.mock('socket.io-client', () => ({ io: factory }));
import { SocketClient } from '../src/core/socket/socketClient';
describe('Живое соединение разделов', () => {
    beforeEach(() => vi.clearAllMocks());
    it('Повторная подписка использует одно соединение и сохраняет listeners для reconnect', () => {
        const client = new SocketClient();
        const refresh = vi.fn();
        client.connect();
        client.on('section:changed', refresh);
        client.connect();
        expect(factory).toHaveBeenCalledTimes(1);
        expect(raw.on).toHaveBeenCalledWith('section:changed', refresh);
        expect(raw.on).not.toHaveBeenCalledWith(
            'disconnect',
            expect.any(Function),
        );
    });
    it('Отписка снимает только свой обработчик; новый сеанс создаёт новое соединение', () => {
        const client = new SocketClient();
        const refresh = vi.fn();
        client.connect();
        client.on('connect', refresh);
        client.off('connect', refresh);
        expect(raw.off).toHaveBeenCalledWith('connect', refresh);
        client.disconnect();
        client.connect();
        expect(factory).toHaveBeenCalledTimes(2);
    });
});
