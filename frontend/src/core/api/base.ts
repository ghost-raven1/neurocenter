import Axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';

declare module 'axios' {
    interface AxiosRequestConfig {
        /** Auth thunk проверяет владельца ответа перед завершением сессии. */
        skipUnauthorizedHandler?: boolean;
    }
}

type TUnauthorizedHandler = () => void;

let unauthorizedHandler: TUnauthorizedHandler = () => undefined;
let currentOwner: () => unknown = () => undefined;
const requestOwners = new WeakMap<AxiosRequestConfig, unknown>();

/**
 * AD-O1/O2: последний X-Request-ID из ответа gateway (nginx $request_id) —
 * correlation для client-репортов ошибок (6.11). Только заголовок-safe значения.
 */
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/i;
let lastRequestId: string | null = null;

/**
 * Возвращает последний увиденный X-Request-ID (null — ответы ещё не приходили).
 *
 * @returns {string | null}
 */
export const getLastRequestId = (): string | null => lastRequestId;

const captureRequestId = (value: unknown): void => {
    if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) {
        lastRequestId = value;
    }
};

/**
 * Регистрирует обработчик 401 и читатель текущего владельца без зависимости API от Redux.
 *
 * @param {TUnauthorizedHandler} handler - колбэк обработки 401
 * @returns void
 */
export const setUnauthorizedHandler = (
    handler: TUnauthorizedHandler,
    readOwner: () => unknown = () => undefined,
): void => {
    unauthorizedHandler = handler;
    currentOwner = readOwner;
};

const instance: AxiosInstance = Axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
    withCredentials: true,
    headers: { 'Content-Type': 'application/json', 'X-Neurocenter-Request': '1' },
});

// Identity хранится только в памяти: профиль не добавляется к HTTP-заголовкам или config.
instance.interceptors.request.use(
    (config) => {
        requestOwners.set(config, currentOwner());
        return config;
    },
    undefined,
    { synchronous: true },
);

instance.interceptors.response.use(
    (response) => {
        captureRequestId(response.headers['x-request-id']);
        return response;
    },
    (error: AxiosError) => {
        captureRequestId(error.response?.headers['x-request-id']);
        if (
            error.response?.status === 401 &&
            error.config &&
            !error.config.skipUnauthorizedHandler &&
            requestOwners.has(error.config) &&
            Object.is(requestOwners.get(error.config), currentOwner())
        ) {
            unauthorizedHandler();
        }

        return Promise.reject(error);
    },
);

export default instance;
