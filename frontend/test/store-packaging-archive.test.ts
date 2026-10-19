import { afterEach, describe, expect, it, vi } from 'vitest';
import { packagingApi } from '../src/modules/Store/packaging/api';
import { readPackagingArchive } from '../src/modules/Store/packaging/sourceArchive';
import type { PackagingInputFile } from '../src/modules/Store/packaging/sourceFiles';

afterEach(() => vi.restoreAllMocks());
const result = { files: [{ path: 'index.ts', content: 'export default 1;' }], skipped: 0, rootName: 'tool' };
function archive(name: string, bytes = new Uint8Array([80, 75, 0, 255])): PackagingInputFile {
    return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer };
}

describe('Загрузка архива для общей сборки инструмента', () => {
    it.each(['tool.zip', 'tool.tar', 'tool.tar.gz', 'tool.tgz', 'TOOL.ZIP'])('Передаёт %s на проверку и возвращает исходники без отдельного пути сборки', async name => {
        const send = vi.spyOn(packagingApi, 'archive').mockResolvedValue(result);
        const controller = new AbortController();
        expect(await readPackagingArchive(archive(name), controller.signal)).toBe(result);
        expect(send).toHaveBeenCalledWith({ name, contentBase64: 'UEsA/w==' }, controller.signal);
    });
    it('Передаёт бинарные данные больше одного блока без потери байтов', async () => {
        const bytes = Uint8Array.from({ length: 90_000 }, (_, index) => index % 256);
        const send = vi.spyOn(packagingApi, 'archive').mockResolvedValue(result);
        await readPackagingArchive(archive('source.tar.gz', bytes));
        expect(Buffer.from(send.mock.calls[0][0].contentBase64, 'base64')).toEqual(Buffer.from(bytes));
    });
    it.each([{ name: 'tool.rar', size: 10 }, { name: 'tool.zip', size: 0 }, { name: 'tool.zip', size: 8 * 1024 * 1024 + 1 }])('Отклоняет недопустимый архив до чтения и запроса: $name, $size байт', async ({ name, size }) => {
        const read = vi.fn(); const send = vi.spyOn(packagingApi, 'archive');
        await expect(readPackagingArchive({ name, size, arrayBuffer: read })).rejects.toThrow();
        expect(read).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
    it('Отмена при закрытии формы не отправляет поздно прочитанный архив', async () => {
        let finish!: (value: ArrayBuffer) => void;
        const reading = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
        const send = vi.spyOn(packagingApi, 'archive');
        const controller = new AbortController();
        const pending = readPackagingArchive({ name: 'tool.zip', size: 1, arrayBuffer: () => reading }, controller.signal);
        controller.abort(); finish(new Uint8Array([1]).buffer);
        await expect(pending).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
    });
    it('При повреждённом архиве показывает отказ сервера и не возвращает старые исходники', async () => {
        vi.spyOn(packagingApi, 'archive').mockRejectedValue(new Error('Архив повреждён.'));
        await expect(readPackagingArchive(archive('tool.zip'))).rejects.toThrow('Архив повреждён.');
    });
    it('Не отправляет файл, размер которого изменился во время чтения', async () => {
        const send = vi.spyOn(packagingApi, 'archive');
        await expect(readPackagingArchive({ ...archive('tool.zip'), size: 12 })).rejects.toThrow('Размер архива изменился');
        expect(send).not.toHaveBeenCalled();
    });
});
