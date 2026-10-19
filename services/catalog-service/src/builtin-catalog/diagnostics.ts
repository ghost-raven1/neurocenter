import { BuiltinCatalogConflict, type IBuiltinConflict } from './planning';

const safeText = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);

/** Контролируемая причина доставки не включает внешние URL и ответы драйверов. */
export class BuiltinCatalogFailure extends Error {}

/** Конфликты содержат только название из поставки и контролируемую причину; настройки не выводятся. */
export function builtinCatalogWarnings(conflicts: readonly IBuiltinConflict[]): string[] {
    return conflicts.map(conflict => `Встроенный каталог: «${safeText(conflict.name)}» пропущен — ${safeText(conflict.reason)} Карточка сохранена; после исправления повторите npm run tools:sync.`);
}

/** Ошибки драйвера не раскрывают URL подключения, SQL и пользовательские параметры. */
export function builtinCatalogError(error: unknown): string {
    if (error instanceof BuiltinCatalogConflict || error instanceof BuiltinCatalogFailure) { return `Встроенный каталог: ${safeText(error.message)}`; }
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && /^[a-z0-9_]{1,32}$/i.test(code)) {
        return `Встроенный каталог: ошибка хранилища или файлов (код ${code}). Проверьте подключение, права и готовую поставку; повторите npm run tools:sync.`;
    }
    return 'Встроенный каталог: обновление не выполнено. Проверьте manifest.json, подключение, права и готовую поставку; повторите npm run tools:sync.';
}
