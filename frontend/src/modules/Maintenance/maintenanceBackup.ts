import base from '../../core/api/base';

export interface ICatalogBackupFile { fileName: string; sizeBytes: number; }
export interface ICatalogBackupResult { createdAt: string; files: ICatalogBackupFile[];warnings?:string[]; }

/** Подтверждает полный результат pg_dump, не принимая пустой ответ за созданную копию. */
export function parseCatalogBackupResult(value: unknown): ICatalogBackupResult {
    const result = value as { backupAt?: unknown; files?: unknown; errors?: unknown;warnings?:unknown } | null;
    if (!result || typeof result.backupAt !== 'string' || !Number.isFinite(Date.parse(result.backupAt))
        || !Array.isArray(result.files) || !result.files.length
        || !Array.isArray(result.errors) || result.errors.length||result.warnings!==undefined&&(!Array.isArray(result.warnings)||result.warnings.some(item=>typeof item!=='string'))) {
        throw new Error('Сервер не подтвердил создание полной резервной копии. Обновите сведения и проверьте журнал операций.');
    }
    const files = result.files.map((value: unknown): ICatalogBackupFile => {
        const file = value as { file?: unknown; sizeBytes?: unknown; method?: unknown } | null;
        if (!file || typeof file.file !== 'string' || !file.file || file.method !== 'pg_dump'
            || typeof file.sizeBytes !== 'number' || !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
            throw new Error('Сервер не подтвердил файл полного дампа. Проверьте журнал операций.');
        }
        const fileName = file.file.split(/[\\/]/).pop();
        if (!fileName) { throw new Error('Сервер не указал имя файла резервной копии.'); }
        return { fileName, sizeBytes: file.sizeBytes };
    });
    return { createdAt: result.backupAt, files,...(result.warnings?{warnings:result.warnings as string[]}:{} ) };
}

/** Сохраняет сведения о созданных файлах; общий bff пока возвращает только void. */
export async function createCatalogBackup(): Promise<ICatalogBackupResult> {
    const { data } = await base.post<unknown>('/api/maintenance/backup');
    return parseCatalogBackupResult(data);
}

/** Дата с временем нужна, чтобы различать несколько копий за день. */
export function formatBackupTime(value: string | null): string {
    if (!value || !Number.isFinite(Date.parse(value))) { return 'Нет сведений'; }
    return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Повторное обновление может принести более новую копию другого администратора. */
export function latestBackupTime(...values: (string | null | undefined)[]): string | null {
    return values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value || '')))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}
