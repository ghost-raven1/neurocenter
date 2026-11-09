/** Читает только известные секреты; ошибка не раскрывает ни путь, ни значение. */
export function loadSecrets(env: Record<string, string | undefined>): void;
/** Production завершается до подключения к БД при неполных или dev-настройках. */
export function validateProduction(env: Record<string, string | undefined>, service: string): void;
/** Доверенный HTTPS URL без учётных данных, query и hash. */
export function httpsUrl(value: string, name: string, originOnly?: boolean): URL;
