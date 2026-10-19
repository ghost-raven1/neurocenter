import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { completeDeviceJob, type DeviceCompletion } from '../src/devices/device-completion';

describe('Подтверждение результата MCP после обрыва', () => {
    const query = vi.fn(); const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    const result = { projectId: 'project', assetId: 'asset', version: 2, manifest: 'a'.repeat(64), bindingId: 'binding' };
    const input: DeviceCompletion = { lease: 'lease', state: 'succeeded', message: 'Файлы записаны', result };
    const row = { id: 'job', email: 'owner@example.test', project_id: 'project', kind: 'install', state: 'reconciling', percent: 35,
        lease_until: new Date(0), payload: { bindingId: 'binding', package: { plugin: { id: 'asset', version: 2 }, manifest: { sha256: result.manifest } } } };
    beforeEach(() => {
        query.mockReset(); release.mockClear();
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [row] : [] }));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    });
    afterEach(() => vi.unstubAllGlobals());
    it('Принимает известный локальный результат после истечения аренды без повторной установки', async () => {
        await expect(completeDeviceJob(pool, 'computer', 'job', input)).resolves.toEqual({ ok: true, repeated: false });
        expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))?.[1]).toEqual(['job', 'succeeded', 100, input.message, result]);
        expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
    it.each(['install','uninstall'])('Успех %s с действующей арендой также требует полную исходную квитанцию', async kind => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind, state: 'running', lease_until: new Date(Date.now()+60000) }] : [] }));
        for (const changed of [{}, {...result,projectId:'another'}, {...result,assetId:'another'}, {...result,version:1}, {...result,manifest:'b'.repeat(64)}, {...result,bindingId:'another'}]) {
            await expect(completeDeviceJob(pool,'computer','job',{...input,result:changed})).rejects.toMatchObject({status:409});
        }
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
        await expect(completeDeviceJob(pool,'computer','job',input)).resolves.toMatchObject({ok:true});
    });
    it('Ошибка установки с действующей арендой сохраняет подтверждённый отказ до записи', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, state: 'running', lease_until: new Date(Date.now()+60000) }] : [] }));
        await expect(completeDeviceJob(pool,'computer','job',{...input,state:'failed',result})).rejects.toMatchObject({status:409});
        await expect(completeDeviceJob(pool,'computer','job',{...input,state:'failed',result:{...result,unchanged:true}})).resolves.toMatchObject({ok:true});
    });
    it('Повреждённый сохранённый пакет отвергается без смены статуса задания', async () => {
        query.mockImplementation(async (sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,payload:{package:{}}}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',input)).rejects.toMatchObject({status:409});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Повтор уже принятого результата не меняет порядок установки и не создаёт новую операцию', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, state: 'succeeded', result }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', input)).resolves.toEqual({ ok: true, repeated: true });
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT'))).toBe(false);
    });
    it.each([
        { ...result, manifest: 'b'.repeat(64) }, { ...result, version: 1 }, { ...result, assetId: 'another' },
    ])('Чужая квитанция не завершает неопределённую операцию: %j', async changed => {
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, result: changed })).rejects.toMatchObject({ status: 409 });
    });
    it('Не подменяет неизвестный результат обычной ошибкой сети', async () => {
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, state: 'failed', result: {} })).rejects.toMatchObject({ status: 409 });
    });
    it('Подтверждённый откат завершает неопределённую операцию ошибкой', async () => {
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, state: 'failed', result: { ...result, rolledBack: true } })).resolves.toMatchObject({ ok: true });
    });
    it('Отказ до записи файлов завершается после обрыва без несуществующего отката', async () => {
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, state: 'failed', result: { ...result, unchanged: true } })).resolves.toMatchObject({ ok: true });
    });
    it('Отказ без изменений всё равно требует исходную привязку папки', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, payload: { ...row.payload, bindingId: 'original' } }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, state: 'failed', result: { ...result, bindingId: 'another', unchanged: true } })).rejects.toMatchObject({ status: 409 });
    });
    it('Отменённое задание и неверная аренда не становятся успешными', async () => {
        for (const rows of [[{ ...row, state: 'cancelled' }], []]) {
            query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? rows : [] }));
            await expect(completeDeviceJob(pool, 'computer', 'job', input)).rejects.toMatchObject({ status: 409 });
        }
    });
    it.each([
        ['choose-root', { root: '/проекты' }], ['bind-project', { projectId: 'project' }],
    ])('Потерянный результат %s сверяется после истечения аренды', async (kind, outcome) => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind, payload: {} }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, result: outcome as Record<string, unknown> })).resolves.toMatchObject({ ok: true });
    });
    it.each(['bind-project', 'sync-rag', 'restore-rag'])('Результат %s для другого проекта не подтверждает задание', async kind => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind, payload: {} }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, result: { projectId: 'another', ok: true } })).rejects.toMatchObject({ status: 409 });
    });
    it('Ошибка выбора папки после обрыва не блокирует доставку остальных результатов', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind: 'choose-root', payload: {} }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, state: 'failed', result: {} })).resolves.toMatchObject({ ok: true });
    });
    it('Пустой результат не выдаётся за выбранную локальную папку', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ ...row, kind: 'choose-root', payload: {} }] : [] }));
        await expect(completeDeviceJob(pool, 'computer', 'job', { ...input, result: {} })).rejects.toMatchObject({ status: 409 });
    });
    it('Ошибка записи журнала откатывает и финальный статус задания', async () => {
        query.mockImplementation(async (sql: string) => {
            if (sql.includes('INSERT INTO operations')) { throw new Error('Нет места'); }
            return { rows: sql.startsWith('SELECT') ? [row] : [] };
        });
        await expect(completeDeviceJob(pool, 'computer', 'job', input)).rejects.toThrow('Нет места');
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(release).toHaveBeenCalled();
    });
    it('Восстановление не публикует произвольные поля или локальные пути из квитанции', async () => {
        const payload={...row.payload,changePlanId:'plan',expectedChangeDigest:'d'.repeat(64)};
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind:'apply-local-change',payload}]:[]}));
        const outcome={...result,changePlanId:'plan',digest:payload.expectedChangeDigest,unchanged:true};
        for(const changed of [{extra:'CONFIG_SECRET'},{recoveryPath:'/Users/private/history'},{changed:'secret'},{readiness:'secret'},{packages:['secret']}]){
            await expect(completeDeviceJob(pool,'computer','job',{...input,state:'failed',message:'SECRET',result:{...outcome,...changed}})).rejects.toMatchObject({status:409});
        }
        await expect(completeDeviceJob(pool,'computer','job',{...input,state:'failed',message:'SECRET',result:outcome})).resolves.toMatchObject({ok:true});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1][3]).toBe('Восстановление не выполнено. Локальный вариант сохранён.');
    });
    it('Принимает восстановленный runtime с changed=true и без изменений файлов проекта',async()=>{
        const payload={...row.payload,changePlanId:'plan',expectedChangeDigest:'d'.repeat(64)};
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind:'apply-local-change',payload}]:[],rowCount:1}));
        const outcome={...result,changePlanId:'plan',digest:payload.expectedChangeDigest,files:0,changed:true,readiness:'unverified'};
        await expect(completeDeviceJob(pool,'computer','job',{...input,result:outcome})).resolves.toMatchObject({ok:true});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE bridge_jobs'))?.[1][4]).toEqual(outcome);
        expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    });
});
