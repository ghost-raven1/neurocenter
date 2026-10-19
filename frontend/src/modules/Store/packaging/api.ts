import base from '../../../core/api/base';
import type { NpmPackageMetadata, RepositoryMetadata, RepositoryQuery, ToolBuild, ToolBuildRequest } from './types';
import type { AxiosRequestConfig } from 'axios';
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
    archive: (body: { name: string; contentBase64: string }, signal?: AbortSignal): Promise<PackagingFilesResult> => bounded(30_000, config => base.post<PackagingFilesResult>('/api/tool-builds/archive', body, config).then(response => response.data), signal),
    npm: (specifier: string, signal?: AbortSignal): Promise<NpmPackageMetadata> => bounded(90_000, config => base.get<NpmPackageMetadata>('/api/tool-builds/npm', { ...config, params: { specifier } }).then(response => response.data), signal),
    repository: (params: RepositoryQuery, signal?: AbortSignal): Promise<RepositoryMetadata> => bounded(90_000, config => base.get<RepositoryMetadata>('/api/tool-builds/repository', { ...config, params }).then(response => response.data), signal),
    create: (body: ToolBuildRequest, signal?: AbortSignal): Promise<ToolBuild> => bounded(90_000, config => base.post<ToolBuild>('/api/tool-builds', body, config).then(response => response.data), signal),
    get: (id: string, signal?: AbortSignal): Promise<ToolBuild> => bounded(10_000, config => base.get<ToolBuild>('/api/tool-builds/' + encodeURIComponent(id), config).then(response => response.data), signal),
    lookup: (key: string, signal?: AbortSignal): Promise<ToolBuild> => bounded(10_000, config => base.get<ToolBuild>('/api/tool-builds/requests/' + encodeURIComponent(key), config).then(response => response.data), signal),
};
