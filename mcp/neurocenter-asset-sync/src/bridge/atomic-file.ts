import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** POSIX фиксирует и содержимое, и переименование; Windows требует отдельной нативной приёмки. */
export async function syncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }
    const handle = await fs.open(directory, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Фиксируем содержимое и запрошенные права временного файла до атомарной публикации. */
export async function atomicText(
    file: string,
    text: string,
    mode: number,
    encoding: 'utf8' | 'base64' = 'utf8',
): Promise<void> {
    // Имя исходного файла может уже занимать почти весь лимит компонента пути.
    const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
    try {
        const handle = await fs.open(temporary, 'wx', mode);
        try {
            await handle.writeFile(text, encoding);
            await handle.chmod(mode);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
        await syncDirectory(path.dirname(file));
    } finally {
        await fs.rm(temporary, { force: true });
    }
}
