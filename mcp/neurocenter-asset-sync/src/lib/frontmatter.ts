import { load } from 'js-yaml';

/**
 * Lenient-разбор frontmatter «вручную»: по строкам `key: value`.
 * Спасает скалярные поля (name/description/...), когда строгий YAML роняет
 * исключение (напр. `: ` внутри не-квантованной description).
 *
 * @param text - тело блока frontmatter.
 * @returns объект ключ→значение (скаляр/массив).
 */
function parseLenient(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);

        if (!m) {
            continue;
        }

        const key = m[1] ?? '';
        const rawVal = (m[2] ?? '').trim();

        if (/^\[.*\]$/.test(rawVal)) {
            const inner = rawVal.slice(1, -1).trim();
            out[key] = inner === '' ? [] : inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            continue;
        }
        if (rawVal.length >= 2 && /^['"]/.test(rawVal) && /['"]$/.test(rawVal)) {
            out[key] = rawVal.slice(1, -1);
            continue;
        }
        out[key] = rawVal;
    }

    return out;
}

/**
 * Извлекает YAML-фронтматтер (блок между первыми двумя строками `---`) из
 * текста `.md` и парсит его в объект.
 *
 * @param raw - полное содержимое файла.
 * @returns парsiрованный frontmatter (`null` — блока нет).
 */
export function extractFrontmatter<T = Record<string, unknown>>(raw: string): T | null {
    const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
    if (!m || !m[1]) {
        return null;
    }
    try {
        const data = load(m[1]);
        return (typeof data === 'object' && data !== null ? data : null) as T;
    } catch {
        const lenient = parseLenient(m[1]);
        return (Object.keys(lenient).length > 0 ? lenient : null) as T | null;
    }
}
