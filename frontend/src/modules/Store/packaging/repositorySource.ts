import type { PackagingSource, RepositoryMetadata, RepositoryQuery } from './types';

/** Секреты из URL не передаются серверу; в этом режиме поддержан публичный GitHub HTTPS. */
export function repositoryQuery(input: RepositoryQuery): RepositoryQuery {
    let url: URL;
    try { url = new URL(input.url.trim()); } catch { throw new Error('Укажите ссылку вида https://github.com/owner/repository.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search) throw new Error('Нужна HTTPS-ссылка на публичный GitHub, без токена и SSH.');
    url.hash = '';
    return { url: url.href, ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}), ...(input.subdirectory?.trim() ? { subdirectory: input.subdirectory.trim() } : {}), ...(input.entrypoint?.trim() ? { entrypoint: input.entrypoint.trim() } : {}) };
}

/** Сборка получает проверенный commit, поэтому изменение ветки после просмотра не меняет исходники. */
export function repositoryBuildSource(metadata: RepositoryMetadata, entrypoint: string): Extract<PackagingSource, { type: 'repository' }> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata.commit)) throw new Error('Сервер не зафиксировал commit репозитория. Повторите проверку.');
    const selected = metadata.adapter ? metadata.entrypoint : entrypoint || metadata.entrypoint;
    if (!selected) throw new Error('Выберите файл запуска репозитория.');
    return { type: 'repository', url: metadata.url, ref: metadata.commit, ...(metadata.subdirectory ? { subdirectory: metadata.subdirectory } : {}), entrypoint: selected };
}

export function repositoryName(url: string): string {
    try { return new URL(url).pathname.split('/')[2]?.replace(/\.git$/, '') || 'Мой инструмент'; } catch { return 'Мой инструмент'; }
}
