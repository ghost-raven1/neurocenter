import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Не позволяет выпустить прежний или изменённый dist под новой версией пакета. */
export async function verifyBridgeBuild(directory, version) {
    const build = JSON.parse(await fs.readFile(path.join(directory, 'build.json'), 'utf8'));
    if (build.version !== version || !/^[a-f0-9]{64}$/.test(build.buildId)) {
        throw new Error('Версия сборки моста не совпадает с пакетом. Выполните чистую сборку перед упаковкой.');
    }
    const digest = createHash('sha256');
    for (const file of (await fs.readdir(directory, { recursive: true })).sort()) {
        const full = path.join(directory, file), info = await fs.lstat(full);
        if (info.isSymbolicLink()) throw new Error('В сборке моста обнаружена ссылка: ' + file);
        if (file !== 'build.json' && info.isFile()) {
            digest.update(file.split(path.sep).join('/') + '\0');
            digest.update(await fs.readFile(full));
        }
    }
    if (digest.digest('hex') !== build.buildId) {
        throw new Error('Отпечаток сборки моста не совпадает с dist. Повторите чистую сборку.');
    }
    return build;
}
