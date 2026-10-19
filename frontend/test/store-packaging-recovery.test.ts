import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBuildCheckpoint, saveBuildCheckpoint } from '../src/modules/Store/packaging/buildRecovery';

const request = '77fbc358-c183-4af8-b784-55d0aff94a1a';
const job = '1d962589-a348-4909-a6bb-c0b6299550fc';
afterEach(() => vi.unstubAllGlobals());

function browser(storageAvailable = false) {
    const values = new Map<string, string>();
    const history = { state: { key: 'router', state: { from: '/projects' } } as Record<string, unknown>, replaceState(next: Record<string, unknown>) { this.state = next; } };
    const unavailable = () => { throw new DOMException('Storage запрещён', 'SecurityError'); };
    vi.stubGlobal('localStorage', storageAvailable ? {
        getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
    } : { getItem: unavailable, setItem: unavailable, removeItem: unavailable });
    vi.stubGlobal('window', { history });
    return { history, values };
}

describe('Восстановление упаковки без доступа к localStorage', () => {
    it('UUID читается после потери состояния React, сохраняя поля Router и область владельца', () => {
        const { history } = browser();
        expect(saveBuildCheckpoint('alice', 'request', request)).toBe(true);
        const reloadedEntry = structuredClone(history.state);
        vi.stubGlobal('window', { history: { state: reloadedEntry } });
        expect(readBuildCheckpoint('alice', 'request')).toBe(request);
        expect(readBuildCheckpoint('bob', 'request')).toBeUndefined();
        expect(reloadedEntry).toMatchObject({ key: 'router', state: { from: '/projects' } });
        expect(JSON.stringify(reloadedEntry)).not.toContain('source');
    });
    it('Найденная сборка заменяет pending UUID и возобновляется после reload без нового POST', () => {
        const { history } = browser();
        saveBuildCheckpoint('alice', 'request', request);
        expect(saveBuildCheckpoint('alice', 'job', job)).toBe(true);
        saveBuildCheckpoint('alice', 'request');
        vi.stubGlobal('window', { history: { state: structuredClone(history.state) } });
        expect(readBuildCheckpoint('alice', 'job')).toBe(job);
        expect(readBuildCheckpoint('alice', 'request')).toBeUndefined();
    });
    it('История текущей вкладки не подменяется сборкой другой вкладки из общего storage', () => {
        const { values } = browser(true);
        saveBuildCheckpoint('alice', 'request', request);
        values.set('neurocenter.tool-build:alice', job);
        expect(readBuildCheckpoint('alice', 'job')).toBeUndefined();
        expect(readBuildCheckpoint('alice', 'request')).toBe(request);
    });
    it('Явное завершение очищает checkpoint, не затрагивая Router и другого владельца', () => {
        const { history } = browser();
        saveBuildCheckpoint('alice', 'job', job);
        saveBuildCheckpoint('bob', 'job');
        expect(readBuildCheckpoint('alice', 'job')).toBe(job);
        saveBuildCheckpoint('alice', 'job');
        expect(readBuildCheckpoint('alice', 'job')).toBeUndefined();
        expect(history.state).toEqual({ key: 'router', state: { from: '/projects' } });
    });
    it('Обычное storage остаётся доступно, даже если history API запрещён', () => {
        const { history } = browser(true);
        history.replaceState = () => { throw new DOMException('История запрещена', 'SecurityError'); };
        expect(saveBuildCheckpoint('alice', 'request', request)).toBe(true);
        expect(readBuildCheckpoint('alice', 'request')).toBe(request);
    });
    it('Отказ обоих способов сохранения явно возвращает false до отправки запроса', () => {
        const { history } = browser();
        history.replaceState = () => { throw new DOMException('История запрещена', 'SecurityError'); };
        expect(saveBuildCheckpoint('alice', 'request', request)).toBe(false);
        expect(readBuildCheckpoint('alice', 'request')).toBeUndefined();
    });
    it('Повреждённый checkpoint не подменяет текущую сборку', () => {
        const { history } = browser(true);
        history.state.neurocenterToolBuild = { scope: 'alice', kind: 'job', id: '../other' };
        expect(readBuildCheckpoint('alice', 'job')).toBeUndefined();
    });
});
