import { io } from 'socket.io-client';

import type { TSocketHandlers } from './interfaces';

/* Минимальный контракт «сырого» сокета, чтобы не тащить в подписки типы socket.io. */
interface IRawSocket {
    on(event: string, listener: (...args: unknown[]) => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
    disconnect(): void;
}

/**
 * Обёртка над клиентом socket.io: подключение, подписки, отключение.
 * Источник истины — каталог PG; события только «будят» обновления state.
 */
export class SocketClient {
    private socket: IRawSocket | null = null;

    /**
     * Подключается к серверу (идемпотентно).
     *
     * @returns void
     */
    public connect(): void {
        if (this.socket) {
            return;
        }

        const rawSocket = io(undefined, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
        }) as unknown as IRawSocket;

        // Тот же экземпляр восстанавливает соединение и сохраняет подписки после обрыва.
        this.socket = rawSocket;
    }

    /**
     * Подписывается на событие.
     *
     * @param {keyof TSocketHandlers} event - имя события
     * @param {TSocketHandlers[keyof TSocketHandlers]} handler - обработчик
     * @returns void
     */
    public on<K extends keyof TSocketHandlers>(event: K, handler: TSocketHandlers[K]): void {
        this.socket?.on(event, handler as (...args: unknown[]) => void);
    }

    /**
     * Отписывается от события.
     *
     * @param {keyof TSocketHandlers} event - имя события
     * @param {TSocketHandlers[keyof TSocketHandlers]} handler - обработчик
     * @returns void
     */
    public off<K extends keyof TSocketHandlers>(event: K, handler: TSocketHandlers[K]): void {
        this.socket?.off(event, handler as (...args: unknown[]) => void);
    }

    /**
     * Отключается от сервера.
     *
     * @returns void
     */
    public disconnect(): void {
        this.socket?.disconnect();
        this.socket = null;
    }
}

export default new SocketClient();
