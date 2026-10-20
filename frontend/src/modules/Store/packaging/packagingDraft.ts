import type { PackagingFile } from './types';

export type PackagingSourceMode = 'npm' | 'files' | 'repository' | 'upload';

/** Ссылка из буфера выбирает поддерживаемый источник, не обходя серверную проверку. */
export function packagingReferenceSource(value: string): 'npm' | 'repository' | undefined {
    if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/i.test(value.trim())) return 'repository';
    if (/^https:\/\/(?:www\.)?npmjs\.com\/package\/[^\s]+/i.test(value.trim())) return 'npm';
    return undefined;
}

/** Название и описание локального пакета заполняют карточку без ручного копирования. */
export function packagingFilesMetadata(files: PackagingFile[]): { name?: string; description?: string } {
    try {
        const value: unknown = JSON.parse(files.find(file => file.path === 'package.json')?.content ?? '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const metadata = value as { name?: unknown; description?: unknown };
        return {
            name: typeof metadata.name === 'string' ? metadata.name.trim() || undefined : undefined,
            description: typeof metadata.description === 'string' ? metadata.description.trim() || undefined : undefined,
        };
    } catch { return {}; }
}
