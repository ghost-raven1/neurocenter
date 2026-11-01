import { packagingApi } from '../api';
import { repositoryQuery } from '../repositorySource';
import { usePackagingMetadata } from './usePackagingMetadata';
import type { IRepositoryQuery } from '../interfaces';

export function useRepositoryMetadata(input: IRepositoryQuery) {
    const query = {
        url: input.url.trim(),
        ref: input.ref?.trim(),
        subdirectory: input.subdirectory?.trim(),
        entrypoint: input.entrypoint?.trim(),
        ...(input.release ? { release: input.release } : {}),
    };
    return usePackagingMetadata(
        JSON.stringify(query),
        () => packagingApi.repository(repositoryQuery(query)),
        'Не удалось проверить репозиторий. Проверьте ссылку, ветку, подпапку и файл запуска.',
    );
}
