import {mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';

/** Не позволяет смонтировать вместо проектных данных симлинк на пользовательский Ollama. */
export async function dataDirectory(config, relative = '', create = false) {
    let current = config.root;
    const parts = [...path.relative(config.root, config.data).split(path.sep).filter(Boolean), ...relative.split('/').filter(Boolean)];
    if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes('\\'))) throw new Error('Каталог моделей должен находиться внутри проекта.');
    for (const part of parts) {
        current = path.join(current, part);
        if (create) {
            try {await mkdir(current, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталоги data/embedding должны находиться в проекте, без символьных ссылок.');
    }
    return current;
}
