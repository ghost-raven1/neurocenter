import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it, vi } from 'vitest';

import bffApi from '../src/core/api/bff';
import type { IBackupStatus } from '../src/core/api/interfaces';
import { parseCatalogBackupResult, formatBackupTime, latestBackupTime } from '../src/modules/Maintenance/maintenanceBackup';
import reducer from '../src/modules/Maintenance/redux/reducers';
import { fetchBackup, fetchStorage } from '../src/modules/Maintenance/redux/actions';
import { authInit } from '../src/features/UserBlock/redux/actions';
import type { IAuthMe } from '../src/core/interfaces';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));
vi.mock('../src/core/api/bff', () => ({ default: { getBackup: vi.fn(), getStorage: vi.fn() } }));

function signedIn() {
    const auth: IAuthMe = {
        user: { id: 'admin', email: 'admin@example.test', principalName: 'admin', displayName: 'Администратор',
            activeRole: 'Главный админ', userRoles: ['Главный админ'], routePermissions: ['maintenance'], projectRoles: [] },
        policies: { maintenance: ['read', 'write'] },
    };
    return reducer(reducer(undefined, authInit.pending('login', undefined)), authInit.fulfilled(auth, 'login', undefined));
}

describe('Достоверность резервной копии каталога', () => {
    const result = {
        backupAt: '2026-10-16T10:00:00.000Z', errors: [],
        files: [{ file: '/server/backups/catalog.dump', sizeBytes: 1024, method: 'pg_dump' }],
    };

    it('Показывает имя и размер полного дампа, скрывая служебный путь сервера', () => {
        expect(parseCatalogBackupResult(result)).toEqual({ createdAt: result.backupAt, files: [{ fileName: 'catalog.dump', sizeBytes: 1024 }] });
    });

    it.each([
        ['пустой ответ', undefined],
        ['пустой список файлов', { ...result, files: [] }],
        ['частичное копирование с ошибкой', { ...result, errors: ['RAG недоступна'] }],
        ['пустой файл', { ...result, files: [{ ...result.files[0], sizeBytes: 0 }] }],
        ['CSV вместо полного дампа', { ...result, files: [{ ...result.files[0], method: 'csv' }] }],
        ['неизвестная дата', { ...result, backupAt: 'не дата' }],
        ['каталог вместо имени файла', { ...result, files: [{ ...result.files[0], file: '/server/backups/' }] }],
    ])('Не подтверждает успех: %s', (_, value) => {
        expect(() => parseCatalogBackupResult(value)).toThrow();
    });

    it('Некорректная дата не отображается как Invalid Date', () => {
        expect(formatBackupTime('повреждённая дата')).toBe('Нет сведений');
        expect(formatBackupTime(null)).toBe('Нет сведений');
    });

    it('Обновление показывает более новую копию другого администратора', () => {
        expect(latestBackupTime('2026-10-16T10:00:00Z', '2026-10-16T11:00:00Z')).toBe('2026-10-16T11:00:00Z');
        expect(latestBackupTime('2026-10-16T10:00:00Z', 'ошибка', null)).toBe('2026-10-16T10:00:00Z');
    });
});

describe('Независимая загрузка данных обслуживания', () => {
    const storage = { totalBytesUsed: 128, totalBytesLimit: 0, stagingBytesBudget: 0, buckets: [] };
    const backup: IBackupStatus = { lastBackupAt: null, backupLagSeconds: 0, restoreDrills: [] };

    it.each([401, 403])('Отказ доступа %s очищает размеры и копии после успешной загрузки', async code => {
        const store = configureStore({ reducer, preloadedState: signedIn() });
        vi.mocked(bffApi.getStorage).mockResolvedValueOnce(storage);
        vi.mocked(bffApi.getBackup).mockResolvedValueOnce(backup);
        await store.dispatch(fetchStorage());
        await store.dispatch(fetchBackup());
        const failure = { isAxiosError: true, response: { status: code, data: { message: 'Доступ отозван' } } };
        vi.mocked(bffApi.getStorage).mockRejectedValueOnce(failure);
        vi.mocked(bffApi.getBackup).mockRejectedValueOnce(failure);
        await store.dispatch(fetchStorage());
        await store.dispatch(fetchBackup());
        expect(store.getState().storage).toBeNull();
        expect(store.getState().backup).toBeNull();
        expect(store.getState().backupAccessDenied).toBe(true);
    });

    it('Загрузка размеров не завершает запрос сведений о копии', () => {
        let state = reducer(signedIn(), fetchStorage.pending('storage', undefined));
        state = reducer(state, fetchBackup.pending('backup', undefined));
        state = reducer(state, fetchStorage.fulfilled(storage, 'storage', undefined));
        expect(state.storageLoading).toBe(false);
        expect(state.backupLoading).toBe(true);
    });

    it('Сохраняет прошлые размеры и показывает ошибку повторного обновления', () => {
        let state = reducer(signedIn(), fetchStorage.pending('first', undefined));
        state = reducer(state, fetchStorage.fulfilled(storage, 'first', undefined));
        state = reducer(state, fetchStorage.pending('retry', undefined));
        state = reducer(state, fetchStorage.rejected(new Error('Сеть'), 'retry', undefined, { message: 'Хранилище недоступно', accessDenied: false }));
        expect(state.storage).toEqual(storage);
        expect(state.storageError).toBe('Хранилище недоступно');
        expect(state.storageLoading).toBe(false);
    });

    it('Запоздалый ответ не подменяет более свежие сведения о копии', () => {
        let state = reducer(signedIn(), fetchBackup.pending('old', undefined));
        state = reducer(state, fetchBackup.pending('new', undefined));
        state = reducer(state, fetchBackup.fulfilled(backup, 'new', undefined));
        state = reducer(state, fetchBackup.fulfilled({ ...backup, lastBackupAt: '2020-01-01' }, 'old', undefined));
        expect(state.backup).toEqual(backup);
        expect(state.backupLoading).toBe(false);
    });

    it('Повторная загрузка очищает ошибку только своего блока', () => {
        let state = reducer(signedIn(), fetchBackup.pending('first', undefined));
        state = reducer(state, fetchBackup.rejected(new Error('Сеть'), 'first', undefined, { message: 'Бэкап недоступен', accessDenied: false }));
        state = reducer(state, fetchStorage.pending('storage', undefined));
        expect(state.backupError).toBe('Бэкап недоступен');
        state = reducer(state, fetchBackup.pending('retry', undefined));
        expect(state.backupError).toBeNull();
        expect(state.backupLoading).toBe(true);
    });

    it('Ошибка старого запроса после фонового обновления не затирает свежую копию', async () => {
        let rejectPrevious!: (error: Error) => void;
        let resolveFresh!: (value: typeof backup) => void;
        const previous = new Promise<typeof backup>((_, reject) => { rejectPrevious = reject; });
        const fresh = new Promise<typeof backup>(resolve => { resolveFresh = resolve; });
        vi.mocked(bffApi.getBackup).mockReturnValueOnce(previous).mockReturnValueOnce(fresh);
        const store = configureStore({ reducer, preloadedState: signedIn() });
        const initialRequest = store.dispatch(fetchBackup());
        const backgroundRequest = store.dispatch(fetchBackup());
        const currentBackup = { ...backup, lastBackupAt: '2026-10-16T11:00:00Z' };
        resolveFresh(currentBackup);
        await backgroundRequest;
        rejectPrevious(new Error('Предыдущее соединение оборвалось'));
        await initialRequest;
        expect(store.getState().backup).toEqual(currentBackup);
        expect(store.getState().backupError).toBeNull();
        expect(store.getState().backupLoading).toBe(false);
    });
});
