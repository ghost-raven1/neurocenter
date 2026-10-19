import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const snapshots = new Map();
const conflict = () => ({ status: 409, body: { error: 'Настройки изменились вне этого окна. Откройте OpenCodeRAG UI заново перед сохранением.' } });

function snapshot(root, file) {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Путь настроек вне проекта.');
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Ссылка в пути настроек.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.nlink !== 1) throw new Error('Нужен обычный файл настроек.');
        return { bytes: fs.readFileSync(file), ino: info.ino, dev: info.dev, mode: info.mode & 0o777 };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const equal = (left, right) => left === null || right === null ? left === right
    : left.ino === right.ino && left.dev === right.dev && left.bytes.equals(right.bytes);

/** Запоминает файл или его отсутствие без создания настроек при запуске UI. */
export function rememberUiConfig(root, file) {
    snapshots.set(file, { root, value: snapshot(root, file) });
}

/** Вызывается после native-валидации под writer lock; defaults и private env не попадают на диск. */
export function persistUiConfigPatch(file, indexingPatch) {
    const initial = snapshots.get(file);
    if (!initial) return { status: 503, body: { error: 'Перезапустите окно OpenCodeRAG перед сохранением настроек.' } };
    let temporary;
    try {
        if (!equal(initial.value, snapshot(initial.root, file))) return conflict();
        const raw = initial.value ? JSON.parse(initial.value.bytes.toString('utf8').replace(/^\uFEFF/, '')) : {};
        const next = Buffer.from(JSON.stringify({ ...raw, indexing: { ...raw.indexing, ...indexingPatch } }, null, 2) + '\n');
        if (!initial.value) {
            fs.writeFileSync(file, next, { flag: 'wx', mode: 0o600 });
        } else {
            temporary = file + '.' + randomUUID() + '.tmp';
            fs.writeFileSync(temporary, next, { flag: 'wx', mode: initial.value.mode });
            if (!equal(initial.value, snapshot(initial.root, file))) return conflict();
            fs.renameSync(temporary, file);
            temporary = undefined;
        }
        initial.value = snapshot(initial.root, file);
        return null;
    } catch (error) {
        if (error.code === 'EEXIST') return conflict();
        return { status: 503, body: { error: 'Настройки не сохранены. Проверьте доступ к файлу проекта и откройте UI заново.' } };
    } finally { if (temporary) fs.rmSync(temporary, { force: true }); }
}
