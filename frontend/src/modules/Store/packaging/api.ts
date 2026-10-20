import base from '../../../core/api/base';
import type { NpmPackageMetadata, RepositoryMetadata, RepositoryQuery, ToolBuild, ToolBuildRequest } from './types';
import type { AxiosRequestConfig } from 'axios';
import {isAxiosError} from 'axios';
import type { PackagingFilesResult } from './sourceFiles';

/** Подготовка включает до трёх metadata-запросов по 20 секунд; чтение статуса имеет короткий предел. */
function bounded<T>(timeout: number, send: (config: AxiosRequestConfig) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return send({ timeout, signal: controller.signal }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

export const packagingApi = {
    /** Проверяет доступ без сборки tar; cookie-authenticated загрузку большого файла ведёт браузер. */
    supply: (id: string, signal?: AbortSignal): Promise<string> => bounded(10_000, async config => {
        const url = '/api/tool-builds/' + encodeURIComponent(id) + '/supply';
        try { await base.head(url, config); }
        catch (cause) {
            // HEAD не передаёт JSON body: объяснение отказа определяется HTTP статусом.
            const messages: Record<number, string> = {
                401: 'Сессия истекла. Войдите снова.', 403: 'Нет прав на скачивание поставки.',
                404: 'Сборка или поставка не найдена.', 409: 'Поставка ещё не готова или её исходники изменились. Повторите упаковку.',
                413: 'Поставка превышает допустимый размер.', 503: 'Поставка временно недоступна. Повторите позже.',
            };
            const message = isAxiosError(cause) && messages[cause.response?.status ?? 0];
            if (message) throw new Error(message);
            throw cause;
        }
        return base.getUri({ url });
    }, signal),
    assetDocument: (id: string, signal?: AbortSignal): Promise<string> => bounded(10_000, config => base.get<string>('/api/tool-builds/' + encodeURIComponent(id) + '/asset', { ...config, responseType: 'text', transformResponse: [value => value] }).then(response => response.data), signal),
    archive: (body: { name: string; contentBase64: string }, signal?: AbortSignal): Promise<PackagingFilesResult> => bounded(30_000, config => base.post<PackagingFilesResult>('/api/tool-builds/archive', body, config).then(response => response.data), signal),
    npm: (specifier: string, signal?: AbortSignal): Promise<NpmPackageMetadata> => bounded(90_000, config => base.get<NpmPackageMetadata>('/api/tool-builds/npm', { ...config, params: { specifier } }).then(response => response.data), signal),
    repository: (params: RepositoryQuery, signal?: AbortSignal): Promise<RepositoryMetadata> => bounded(90_000, config => base.get<RepositoryMetadata>('/api/tool-builds/repository', { ...config, params: { ...params, ...(params.release ? { release: JSON.stringify(params.release) } : {}) } }).then(response => response.data), signal),
    create: (body: ToolBuildRequest, signal?: AbortSignal): Promise<ToolBuild> => bounded(90_000, config => base.post<ToolBuild>('/api/tool-builds', body, config).then(response => response.data), signal),
    get: (id: string, signal?: AbortSignal): Promise<ToolBuild> => bounded(10_000, config => base.get<ToolBuild>('/api/tool-builds/' + encodeURIComponent(id), config).then(response => response.data), signal),
    lookup: (key: string, signal?: AbortSignal): Promise<ToolBuild> => bounded(10_000, config => base.get<ToolBuild>('/api/tool-builds/requests/' + encodeURIComponent(key), config).then(response => response.data), signal),
};
