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
 * Регистрирует обработчик 401 и читатель текущего владельца без зависимости API от Redux.
 *
 * @param {TUnauthorizedHandler} handler - колбэк обработки 401
 * @returns void
 */
export const setUnauthorizedHandler = (handler: TUnauthorizedHandler, readOwner: () => unknown = () => undefined): void => {
    unauthorizedHandler = handler;
    currentOwner = readOwner;
};

const instance: AxiosInstance = Axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
    withCredentials: true,
    headers: { 'Content-Type': 'application/json', 'X-Neurocenter-Request': '1' },
});

// Identity хранится только в памяти: профиль не добавляется к HTTP-заголовкам или config.
instance.interceptors.request.use(config => {
    requestOwners.set(config, currentOwner());
    return config;
}, undefined, { synchronous: true });

instance.interceptors.response.use(
    response => response,
    (error: AxiosError) => {
        if (error.response?.status === 401 && error.config && !error.config.skipUnauthorizedHandler
            && requestOwners.has(error.config) && Object.is(requestOwners.get(error.config), currentOwner())) {
            unauthorizedHandler();
        }

        return Promise.reject(error);
    },
);

export default instance;
