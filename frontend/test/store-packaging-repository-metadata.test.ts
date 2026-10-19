import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ repository: vi.fn(), metadata: vi.fn((_key: string, read: () => Promise<unknown>) => ({ resolve: read })) }));
vi.mock('../src/modules/Store/packaging/api', () => ({ packagingApi: { repository: mocks.repository } }));
vi.mock('../src/modules/Store/packaging/usePackagingMetadata', () => ({ usePackagingMetadata: mocks.metadata }));
import { useRepositoryMetadata } from '../src/modules/Store/packaging/useRepositoryMetadata';

beforeEach(() => { vi.clearAllMocks(); mocks.repository.mockResolvedValue({}); });
describe('Проверка нестандартного файла запуска репозитория', () => {
    it('Передаёт ручной путь в GET с нормализованными параметрами', async () => {
        await useRepositoryMetadata({ url: ' https://github.com/owner/tool ', ref: ' main ', subdirectory: ' packages/tool ', entrypoint: ' custom/server.ts ' }).resolve();
        expect(mocks.repository).toHaveBeenCalledWith({ url: 'https://github.com/owner/tool', ref: 'main', subdirectory: 'packages/tool', entrypoint: 'custom/server.ts' });
    });
    it('Изменение ручного пути создаёт другой ключ и отсекает старую проверку', () => {
        const source = { url: 'https://github.com/owner/tool', entrypoint: 'src/old.ts' };
        useRepositoryMetadata(source);
        useRepositoryMetadata({ ...source, entrypoint: 'src/server.ts' });
        const [first, second] = mocks.metadata.mock.calls;
        expect(first[0]).not.toBe(second[0]);
        expect(JSON.parse(second[0]).entrypoint).toBe('src/server.ts');
    });
    it('Пустое поле сохраняет автоматическое определение entrypoint', async () => {
        await useRepositoryMetadata({ url: 'https://github.com/owner/tool', entrypoint: ' ' }).resolve();
        expect(mocks.repository).toHaveBeenCalledWith({ url: 'https://github.com/owner/tool' });
    });
});
