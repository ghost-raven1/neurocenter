import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicText } from '../src/bridge/atomic-file.js';

describe('Атомарная фиксация локальных данных', () => {
    let root: string;
    afterEach(async () => { vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });
    it('Ошибка диска до публикации сохраняет исходный файл и удаляет временный', async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-durable-'));
        const file = path.join(root, 'credentials.json'); await fs.writeFile(file, 'Старое подключение', { mode: 0o600 });
        const open = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (String(args[0]).endsWith('.tmp')) {
                vi.spyOn(handle, 'sync').mockRejectedValue(Object.assign(new Error('Недостаточно места'), { code: 'ENOSPC' }));
            }
            return handle;
        });
        await expect(atomicText(file, 'Новое подключение', 0o600)).rejects.toMatchObject({ code: 'ENOSPC' });
        expect(await fs.readFile(file, 'utf8')).toBe('Старое подключение');
        expect(await fs.readdir(root)).toEqual(['credentials.json']);
    });
    it('Длинное имя с UTF-8 символами не увеличивается именем временного файла', async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-durable-'));
        const name='a'.repeat(205)+'я'.repeat(10)+'.txt';
        expect(Buffer.byteLength(name)).toBeLessThan(240);
        const file=path.join(root,name);
        await atomicText(file,'Исходные данные',0o600);
        await atomicText(file,'Обновлённые данные',0o600);
        expect(await fs.readFile(file,'utf8')).toBe('Обновлённые данные');
        expect(await fs.readdir(root)).toEqual([name]);
    });
});
