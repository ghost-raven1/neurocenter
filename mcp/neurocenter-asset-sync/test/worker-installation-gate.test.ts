import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorker } from '../src/bridge/worker.js';
import { api, readState, writeState } from '../src/bridge/state.js';
import { waitForWorkerInstallation } from '../src/bridge/worker-upgrade.js';

vi.mock('../src/bridge/worker-upgrade.js', () => ({ waitForWorkerInstallation: vi.fn() }));
vi.mock('../src/bridge/state.js', async importOriginal => ({
    ...await importOriginal<typeof import('../src/bridge/state.js')>(),
    api: vi.fn(), readState: vi.fn(), writeState: vi.fn(),
}));

describe('Установщик блокирует запуск worker до всех операций', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());
    it('Закрытый gate не читает credentials, не пишет lock/version и не вызывает heartbeat/claim', async () => {
        const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValue(new Error('Неожиданная запись до gate'));
        const writeFile = vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('Неожиданная запись до gate'));
        vi.mocked(waitForWorkerInstallation).mockResolvedValue(false);
        await runWorker();
        expect(waitForWorkerInstallation).toHaveBeenCalledOnce();
        expect(readState).not.toHaveBeenCalled(); expect(writeState).not.toHaveBeenCalled(); expect(api).not.toHaveBeenCalled();
        expect(mkdir).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled();
    });
    it('Освобождённый gate разрешает обычное чтение подключения', async () => {
        vi.mocked(waitForWorkerInstallation).mockResolvedValue(true);
        vi.mocked(readState).mockResolvedValue(undefined);
        await runWorker();
        expect(readState).toHaveBeenCalledWith('credentials'); expect(api).not.toHaveBeenCalled();
    });
});
