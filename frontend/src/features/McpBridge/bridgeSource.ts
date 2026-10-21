import api from '../../core/api/base';
import type { IAssetImport } from '../AssetSources/types';
import type {IBridgeDevice} from './api';

export interface IBridgeSourceRelease {
    assetId: string;
    version: string;
    buildId: string;
    repositoryCommit: string;
    repositoryUrl?: string;
    targets: string[];
}
export interface IBridgeSource {
    url: string;
    revision: number;
    checkedAt?: string;
    error?: string;
    importedError?: string;
    available?: IBridgeSourceRelease;
    imported?: IBridgeSourceRelease;
}
export interface IBridgeSourceImportIntent {
    expectedRevision: number;
    commit: string;
    assetId: string;
    requestKey: string;
    jobId?: string;
}

/** В поле источника принимается репозиторий описаний поставок, без секретов и install-скриптов. */
export function bridgeSourceUrl(value: string): string {
    const raw = value.trim();
    try {
        if (raw.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(raw) || raw.split('/').some(part => {
            const decoded = decodeURIComponent(part);
            return decoded === '.' || decoded === '..' || /[\\/\u0000-\u0020\u007f]/.test(decoded);
        })) throw new Error();
    } catch { throw new Error('Укажите прямую ссылку на репозиторий, без переходов между папками и спецсимволов.'); }
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('Укажите HTTPS-ссылку на репозиторий GitHub.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash
        || !/^\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/?$/i.test(url.pathname)) {
        throw new Error('Нужна публичная ссылка https://github.com/owner/repository, без токена, подпапки и install.sh.');
    }
    return url.origin + url.pathname.replace(/\/$/, '').replace(/\.git$/i, '');
}

/** Версии моста имеют стабильный формат x.y.z; неизвестная версия не означает устаревшую. */
export function compareBridgeVersions(installed: string | undefined, available: string): number | undefined {
    const parse = (value: string | undefined) => value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
        ? value.split('.').map(Number) : undefined;
    const left = parse(installed), right = parse(available);
    if (!left || !right || [...left, ...right].some(value => !Number.isSafeInteger(value))) return undefined;
    for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    return 0;
}

/** Имена платформ поставки моста отличаются от целей MCP-runtime. */
export function bridgeDeviceTarget(device: IBridgeDevice | undefined): string | undefined {
    const target = device?.report.runtimeArtifactTarget;
    if (target) return target.replace(/^win32-/, 'windows-').replace(/-glibc$/, '');
    const {platform, arch} = device?.report ?? {};
    return platform && arch ? `${platform === 'win32' ? 'windows' : platform}-${arch}` : undefined;
}

export const bridgeSourceApi = {
    get: (signal?: AbortSignal) => api.get<IBridgeSource>('/api/bridge-source', { signal, timeout: 10000 }).then(response => response.data),
    check: (expectedRevision: number, signal?: AbortSignal, force = false) => api.post<IBridgeSource>('/api/bridge-source/check', { expectedRevision, ...(force ? { force: true } : {}) }, { signal, timeout: 65000 }).then(response => response.data),
    save: (url: string, expectedRevision: number, signal?: AbortSignal) => api.put<IBridgeSource>('/api/bridge-source', { url: bridgeSourceUrl(url), expectedRevision }, { signal, timeout: 15000 }).then(response => response.data),
    import: (intent: IBridgeSourceImportIntent) => api.post<IAssetImport>('/api/bridge-source/import', {
        expectedRevision: intent.expectedRevision, commit: intent.commit, assetId: intent.assetId, requestKey: intent.requestKey,
    }, { timeout: 65000 }).then(response => response.data),
    job: (intent: IBridgeSourceImportIntent) => api.get<IAssetImport>(intent.jobId ? '/api/asset-imports/' + intent.jobId : '/api/asset-imports/by-request/' + intent.requestKey,
        { timeout: 10000 }).then(response => response.data),
    action: (id: string, action: 'retry' | 'cancel') => api.post<IAssetImport>('/api/asset-imports/' + id + '/' + action, undefined, { timeout: 15000 }).then(response => response.data),
    resolve: (id: string, expectedDigest: string) => api.post<IAssetImport>('/api/asset-imports/' + id + '/resolve', {expectedDigest}, {timeout:15000}).then(response => response.data),
};

/** Восстанавливаем только точное намерение; автоматического повторного POST после reload нет. */
export function readBridgeSourceImport(value: string | null): IBridgeSourceImportIntent | undefined {
    try {
        const intent = JSON.parse(value ?? 'null') as IBridgeSourceImportIntent;
        if (intent && Number.isSafeInteger(intent.expectedRevision) && intent.expectedRevision >= 0
            && /^[a-f0-9]{40}$/i.test(intent.commit) && typeof intent.assetId === 'string' && intent.assetId.length > 0
            && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(intent.requestKey)
            && (intent.jobId === undefined || /^[a-f0-9-]{36}$/i.test(intent.jobId))) return intent;
    } catch { /* Повреждённое локальное значение не является запросом сервера. */ }
    return undefined;
}
