import { basename } from 'node:path';

/**
 * Имя базового каталога (для slug/отладки).
 */
export function baseName(p: string): string {
    return basename(p);
}
