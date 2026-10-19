import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ownership = new Map();
const sessions = new Set();
const dead = pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
};

/** Атомарная эксклюзивная запись защищает и bridge restore, и параллельный native проход. */
export async function acquireManagedIndexLock(file) {
    const owner = randomUUID();
    const claim = async () => {
        try {
            await fs.writeFile(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), owner }), { flag: 'wx' });
            ownership.set(file, owner);
            return true;
        } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    };
    if (await claim()) return true;
    const recovery = file + '.recovery';
    try { await fs.mkdir(recovery); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        const bytes = await fs.readFile(file, 'utf8');
        if (!dead(JSON.parse(bytes).pid)) return false;
        const current = await fs.lstat(file);
        if (current.ino !== stat.ino || current.dev !== stat.dev || await fs.readFile(file, 'utf8') !== bytes) return false;
        await fs.unlink(file);
        return await claim();
    } catch (error) { if (['ENOENT', 'SyntaxError'].includes(error.code ?? error.name)) return false; throw error; }
    finally { await fs.rmdir(recovery); }
}

/** finally не удаляет lock, уже занятый другим владельцем после смены каталога. */
export async function releaseManagedIndexLock(file) {
    const owner = ownership.get(file);
    ownership.delete(file);
    if (!owner) return;
    try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (record.owner === owner && record.pid === process.pid) await fs.unlink(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function assertNoIndexWriter(storePath) {
    const file = path.join(storePath, 'index.lock');
    try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (record.owner === ownership.get(file) && record.pid === process.pid) return;
        if (!dead(record.pid)) throw new Error('Идёт восстановление или индексация базы знаний. Дождитесь завершения и перезапустите OpenCode.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Даже с выключенной автоиндексацией открытый native store запрещает замену каталога мостом. */
export async function enterManagedSession(storePath) {
    await assertNoIndexWriter(storePath);
    if (sessions.has(storePath)) return;
    await fs.mkdir(storePath, { recursive: true });
    const file = path.join(storePath, 'neurocenter-session.lock');
    if (!await acquireManagedIndexLock(file)) throw new Error('Этот индекс открыт в другом OpenCode. Закройте другую сессию и повторите подключение.');
    try { await assertNoIndexWriter(storePath);sessions.add(storePath); }
    catch (error) { await releaseManagedIndexLock(file);throw error; }
}

/** Полный rebuild сохраняет presence lock при атомарной замене каталога. */
export async function preserveManagedSessionLock(storePath, temporary) {
    if (sessions.has(storePath)) await fs.copyFile(path.join(storePath, 'neurocenter-session.lock'), path.join(temporary, 'neurocenter-session.lock'), 1);
    const ui = path.join(storePath, 'neurocenter-ui-session.lock');
    try {
        const info = await fs.lstat(ui);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Некорректная блокировка OpenCodeRAG UI.');
        await fs.copyFile(ui, path.join(temporary, 'neurocenter-ui-session.lock'), 1);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Вызывается после закрытия upstream stores и watchers. */
export async function leaveManagedSessions() {
    for (const storePath of sessions) {
        await releaseManagedIndexLock(path.join(storePath, 'neurocenter-session.lock'));
        sessions.delete(storePath);
    }
}
