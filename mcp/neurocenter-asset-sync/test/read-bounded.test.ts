import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBoundedBytes, readBoundedSnapshot, readBoundedUtf8 } from '../src/bridge/read-bounded.js';

describe('Ограниченное чтение локальных снимков', () => {
    let directory: string;
    const target = () => path.join(directory, 'данные');
    beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-bounded-')); });
    afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

    it('Принимает точную границу байтов и пустой файл с нулевым лимитом', async () => {
        await fs.writeFile(target(), 'я');
        await expect(readBoundedUtf8(target(), 2)).resolves.toBe('я');
        await expect(readBoundedUtf8(target(), 1)).rejects.toThrow('допустимого размера');
        await fs.writeFile(target(), '');
        await expect(readBoundedUtf8(target(), 0)).resolves.toBe('');
    });
    it('Не выделяет буфер по размеру большого разреженного файла', async () => {
        await fs.writeFile(target(), ''); await fs.truncate(target(), 1024 * 1048576);
        const open = vi.spyOn(fs, 'open');
        await expect(readBoundedBytes(target(), 1048576)).rejects.toThrow('допустимого размера');
        expect(open).not.toHaveBeenCalled();
    });
    it('Отвергает директорию и симлинк даже на разрешённый обычный файл', async () => {
        await expect(readBoundedUtf8(directory, 1024)).rejects.toThrow('обычным файлом');
        await fs.writeFile(target(), 'данные'); await fs.symlink(target(), path.join(directory, 'ссылка'));
        await expect(readBoundedUtf8(path.join(directory, 'ссылка'), 1024)).rejects.toThrow('обычным файлом');
    });
    it.skipIf(process.platform === 'win32')('Настоящий FIFO отклоняется до открытия и не блокирует процесс', async () => {
        await promisify(execFile)('mkfifo', [target()]);
        const open = vi.spyOn(fs, 'open');
        await expect(readBoundedUtf8(target(), 1024)).rejects.toThrow('обычным файлом');
        expect(open).not.toHaveBeenCalled();
    });
    it('Разделяет бинарные данные и повреждённый текст UTF-8', async () => {
        await fs.writeFile(target(), Buffer.from([0xff, 0x80]));
        await expect(readBoundedBytes(target(), 2)).resolves.toEqual(Buffer.from([0xff, 0x80]));
        await expect(readBoundedUtf8(target(), 2)).rejects.toThrow('кодирование');
    });
    it('Отсутствие до чтения остаётся ENOENT', async () => {
        await expect(readBoundedUtf8(target(), 1024)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Подмена inode между lstat и open обнаруживается при одинаковых байтах', async () => {
        await fs.writeFile(target(), 'до');
        const open = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
            await fs.rename(target(), target() + '.старый'); await fs.writeFile(target(), 'до');
            return open(...args);
        });
        await expect(readBoundedSnapshot(target(), 1024)).rejects.toMatchObject({ code: 'ESTALE' });
        expect(await fs.readFile(target(), 'utf8')).toBe('до');
    });
    it('Исчезновение между lstat и open не превращается в отсутствующий исходный файл', async () => {
        await fs.writeFile(target(), 'до'); const open = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
            await fs.unlink(target()); return open(...args);
        });
        await expect(readBoundedSnapshot(target(), 1024)).rejects.toMatchObject({ code: 'ESTALE' });
    });
    it('Дописывание после первого чтения обнаруживается до выдачи снимка', async () => {
        await fs.writeFile(target(), 'до'); const open = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
            const handle = await open(...args); const read = handle.read.bind(handle); let modified = false;
            vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
                const result = await read(...readArgs);
                if (!modified) { modified = true; await fs.appendFile(target(), 'изменение'); }
                return result;
            });
            return handle;
        });
        await expect(readBoundedSnapshot(target(), 1024)).rejects.toMatchObject({ code: 'ESTALE' });
    });
});
