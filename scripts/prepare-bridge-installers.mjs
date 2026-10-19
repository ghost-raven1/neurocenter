import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readBridgeRuntimeRelease} from './bridge-runtime-release.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const templates = [
    {file: 'install.sh', pattern: /^VERSION='[^'\r\n]+'$/gm, declaration: version => `VERSION='${version}'`},
    {file: 'install.ps1', pattern: /^\$Version = '[^'\r\n]+'$/gm, declaration: version => `$Version = '${version}'`},
];

/** Обе раздаваемые версии выводятся из package; опубликованная опись не может ему противоречить. */
export async function prepareBridgeInstallers({directory = repository, verifyOnly = false} = {}) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'mcp/neurocenter-asset-sync/package.json'), 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) { throw new Error('Некорректная версия пакета моста.'); }
    try {
        const release = await readBridgeRuntimeRelease({directory});
        if (release.version !== manifest.version) { throw new Error('Версия установщика не согласована с опубликованной поставкой моста.'); }
    } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    const candidates = [];
    for (const template of templates) {
        const file = path.join(directory, 'bridge-dist', template.file), info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256 * 1024) {
            throw new Error('Шаблон установщика должен быть небольшим обычным файлом без ссылок.');
        }
        const original = await fs.readFile(file, 'utf8');
        if ([...original.matchAll(template.pattern)].length !== 1) { throw new Error('В установщике должна быть одна строка версии.'); }
        const content = original.replace(template.pattern, () => template.declaration(manifest.version));
        candidates.push({file, name: template.file, info, original, content});
    }
    const changed = candidates.filter(candidate => candidate.content !== candidate.original);
    if (verifyOnly && changed.length) { throw new Error('Версия установщиков отстаёт от пакета моста. Повторите npm run bridge:prepare.'); }
    const staged = [], published = [], retained = new Set();
    try {
        for (const candidate of verifyOnly ? [] : changed) {
            const temporary = candidate.file + '.' + randomUUID() + '.tmp';
            const previous = candidate.file + '.' + randomUUID() + '.previous';
            const replacement = {...candidate, temporary, previous};
            staged.push(replacement);
            await fs.writeFile(temporary, candidate.content, {flag: 'wx', mode: candidate.info.mode & 0o777});
            await fs.chmod(temporary, candidate.info.mode & 0o777);
            replacement.identity = await fs.lstat(temporary);
            await fs.writeFile(previous, candidate.original, {flag: 'wx', mode: candidate.info.mode & 0o777});
            await fs.chmod(previous, candidate.info.mode & 0o777);
        }
        // Проверяем прямо перед каждой заменой, включая правку второго файла после первого rename.
        for (const candidate of staged) {
            const current = await fs.lstat(candidate.file);
            if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
                || current.ino !== candidate.info.ino || current.dev !== candidate.info.dev
                || await fs.readFile(candidate.file, 'utf8') !== candidate.original) {
                throw new Error('Шаблон установщика изменился во время подготовки. Повторите команду.');
            }
            await fs.rename(candidate.temporary, candidate.file);
            published.push(candidate);
        }
    } catch (error) {
        for (const candidate of published.reverse()) {
            try {
                const current = await fs.lstat(candidate.file);
                if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
                    || current.ino !== candidate.identity.ino || current.dev !== candidate.identity.dev
                    || await fs.readFile(candidate.file, 'utf8') !== candidate.content) {
                    throw new Error('Опубликованный шаблон изменён другим владельцем.');
                }
                await fs.rename(candidate.previous, candidate.file);
            } catch { retained.add(candidate.previous); }
        }
        if (retained.size) {
            throw new Error('Не удалось безопасно восстановить установщики. Резервные копии: '
                + [...retained].join(', '), {cause: error});
        }
        throw error;
    } finally {
        await Promise.all(staged.flatMap(candidate => [candidate.temporary,
            ...(retained.has(candidate.previous) ? [] : [candidate.previous])]).map(file => fs.rm(file, {force: true})));
    }
    return {version: manifest.version, changed: changed.map(candidate => candidate.name)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--check')) {
        console.error('Использование: node scripts/prepare-bridge-installers.mjs [--check]');
        process.exitCode = 1;
    } else {
        prepareBridgeInstallers({verifyOnly: args[0] === '--check'})
            .then(result => console.log(JSON.stringify(result)))
            .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
