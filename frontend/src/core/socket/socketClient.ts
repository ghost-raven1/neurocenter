import { io } from 'socket.io-client';

import type { TSocketHandlers } from './interfaces';

/* Минимальный контракт «сырого» сокета, чтобы не тащить в подписки типы socket.io. */
interface IRawSocket {
    readonly active: boolean;
    readonly connected: boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
    connect(): void;
    disconnect(): void;
}

const NAMESPACE_RETRY_MS = 5000;

/**
 * Обёртка над клиентом socket.io: подключение, подписки, отключение.
 * Источник истины — каталог PG; события только «будят» обновления state.
 */
export class SocketClient {
    private socket: IRawSocket | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    private clearRetry(): void {
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }

    /** Socket.IO сам повторяет transport loss, но отключённый namespace требует connect(). */
    private retryInactive(raw: IRawSocket): void {
        if (this.socket !== raw || raw.active || raw.connected || this.retryTimer !== undefined) { return; }
        const timer = setTimeout(() => {
            if (this.socket !== raw || this.retryTimer !== timer) { return; }
            this.retryTimer = undefined;
            if (!raw.active && !raw.connected) { raw.connect(); }
        }, NAMESPACE_RETRY_MS);
        this.retryTimer = timer;
    }

    /**
     * Подключается к серверу (идемпотентно).
     *
     * @returns void
     */
    public connect(): void {
        if (this.socket) {
            this.clearRetry();
            if (!this.socket.active && !this.socket.connected) { this.socket.connect(); }
            return;
        }

        const rawSocket = io(undefined, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
        }) as unknown as IRawSocket;

        // Тот же экземпляр восстанавливает соединение и сохраняет подписки после обрыва.
        this.socket = rawSocket;
        rawSocket.on('disconnect', () => this.retryInactive(rawSocket));
        rawSocket.on('connect_error', () => this.retryInactive(rawSocket));
        rawSocket.on('connect', () => { if (this.socket === rawSocket) { this.clearRetry(); } });
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
        const raw = this.socket;
        this.socket = null;
        this.clearRetry();
        raw?.disconnect();
    }
}

export default new SocketClient();
