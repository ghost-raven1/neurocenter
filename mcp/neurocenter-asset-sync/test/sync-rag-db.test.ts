import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncRagDb } from '../src/tools/sync-rag-db.js';

const mocks = vi.hoisted(() => ({
    tableInfo: vi.fn(),
    enumerateFingerprints: vi.fn(),
    readRowsByIds: vi.fn(),
    locateStore: vi.fn(),
    resolveProjectKey: vi.fn(),
}));

vi.mock('../src/lib/lancedb.js', () => ({
    tableInfo: mocks.tableInfo,
    enumerateFingerprints: mocks.enumerateFingerprints,
    readRowsByIds: mocks.readRowsByIds,
    contentHash: (content: string) => `hash-${content}`,
}));
vi.mock('../src/lib/store.js', () => ({ locateStore: mocks.locateStore }));
vi.mock('../src/tools/resolve-project-key.js', () => ({ resolveProjectKey: mocks.resolveProjectKey }));
// Физическая граница источника проверяется отдельно с настоящей LanceDB.
vi.mock('../src/lib/rag-store-boundary.js', () => ({ ragStoreBoundary: () => async () => undefined }));
// Эти сценарии проверяют алгоритм дельты. Личная авторизация проверяется в bridge-transport отдельно.
vi.mock('../src/bridge/state.js',()=>({authorizedFetch:(route:string,options?:RequestInit)=>fetch('http://localhost:5173'+route,options)}));

describe('Безопасность синхронизации RAG', () => {
    const fetchMock = vi.fn();
    let local: Array<{ id: string; hash: string }>;
    let baseline: Record<string, string>;
    let requests: Array<{ chunks: Array<{ id: string }>; deletes: string[] }>;

    beforeEach(() => {
        vi.resetAllMocks();
        local = [ { id: 'a', hash: 'hash-a' }, { id: 'b', hash: 'hash-b' } ];
        baseline = { a: 'hash-a', b: 'hash-b', obsolete: 'hash-old' };
        requests = [];
        mocks.resolveProjectKey.mockResolvedValue(JSON.stringify({ ok: true, projectKey: 'p', identityVerified: true, instanceId: 'fixture-instance', bindingId: 'fixture-binding' }));
        mocks.locateStore.mockResolvedValue({ storePath: '/fixture/rag_db' });
        mocks.tableInfo.mockImplementation(async () => ({ rowCount: local.length, dimension: 3 }));
        mocks.enumerateFingerprints.mockImplementation(async function* (_store: string, limit: number) {
            for (const row of local.slice(0, limit || local.length)) { yield row; }
        });
        mocks.readRowsByIds.mockImplementation(async function* (_store: string, ids: string[]) {
            for (const id of ids) { yield { id, content: id }; }
        });
        fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
            if (!options) { return Response.json({ ids: baseline }); }
            const body = JSON.parse(String(options.body));
            requests.push(body);
            return Response.json({ upserted: body.chunks.length, deleted: body.deletes.length });
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('Неполный скан не изменяет данные и не вычисляет удаления', async () => {
        const result = JSON.parse(await syncRagDb({ projectKey: 'p', scanLimit: 1 }, '/fixture'));

        expect(result).toMatchObject({ applied: false, scanComplete: false, removedCount: null });
        expect(requests).toEqual([]);
    });

    it('Пробный неполный скан явно сообщает, что список удалений неизвестен', async () => {
        const result = JSON.parse(await syncRagDb({ projectKey: 'p', scanLimit: 1, dryRun: true }, '/fixture'));

        expect(result).toMatchObject({ applied: false, scanComplete: false, removedCount: null });
        expect(result.removed).toEqual([]);
        expect(requests).toEqual([]);
    });

    it('Удаляются только отсутствующие строки после полного скана', async () => {
        const result = JSON.parse(await syncRagDb({ projectKey: 'p' }, '/fixture'));

        expect(result).toMatchObject({ ok: true, applied: true, deleted: 1, remaining: 0 });
        expect(requests).toEqual([ { projectKey: 'p', chunks: [], deletes: [ 'obsolete' ] } ]);
    });

    it('Общий лимит порции учитывает и запись, и удаление', async () => {
        local = [ { id: 'new-a', hash: 'hash-new-a' }, { id: 'new-b', hash: 'hash-new-b' } ];
        baseline = { 'old-a': 'hash-old-a', 'old-b': 'hash-old-b' };
        const result = JSON.parse(await syncRagDb({ projectKey: 'p', limit: 2 }, '/fixture'));

        expect(result).toMatchObject({ appliedNow: 2, remaining: 2 });
        expect(requests.flatMap(r => r.chunks)).toHaveLength(2);
        expect(requests.flatMap(r => r.deletes)).toHaveLength(0);
    });

    it('Ошибка отправки новых строк сохраняет существующие данные', async () => {
        local.push({ id: 'new', hash: 'hash-new' });
        fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
            if (!options) { return Response.json({ ids: baseline }); }
            const body = JSON.parse(String(options.body));
            requests.push(body);
            return body.chunks.length ? new Response('unavailable', { status: 503 }) : Response.json({ deleted: 1 });
        });

        await expect(syncRagDb({ projectKey: 'p' }, '/fixture')).rejects.toThrow('503');
        expect(requests.flatMap(r => r.deletes)).toEqual([]);
    });

    it('Переполнение квоты показывает полное русское действие и не удаляет старые знания',async()=>{
        local.push({id:'new',hash:'hash-new'});
        const message='Лимит базы знаний достигнут. Попросите администратора проекта увеличить лимит. Весь пакет отменён, сохранённые знания не изменены.';
        fetchMock.mockImplementation(async(_url:string,options?:RequestInit)=>{
            if(!options){return Response.json({ids:baseline});}
            requests.push(JSON.parse(String(options.body)));return Response.json({code:'RAG_QUOTA_EXCEEDED',message},{status:413});
        });
        await expect(syncRagDb({projectKey:'p'},'/fixture')).rejects.toThrow(message);
        expect(requests.flatMap(row=>row.deletes)).toEqual([]);
    });

    it('Отказ второго пакета сообщает подтверждённый объём, повтор отправляет только остаток',async()=>{
        local=Array.from({length:101},(_,i)=>({id:String(i),hash:`hash-${i}`}));baseline={obsolete:'hash-old'};
        let capped=true;
        fetchMock.mockImplementation(async(_url:string,options?:RequestInit)=>{
            if(!options){return Response.json({ids:baseline});}
            const body=JSON.parse(String(options.body));requests.push(body);
            if(capped&&requests.length===2){return Response.json({message:'Лимит базы знаний достигнут.'},{status:413});}
            for(const row of body.chunks){baseline[row.id]=`hash-${row.id}`;}
            for(const id of body.deletes){delete baseline[id];}
            return Response.json({upserted:body.chunks.length,deleted:body.deletes.length});
        });
        await expect(syncRagDb({projectKey:'p'},'/fixture')).rejects.toThrow('Ранее подтверждено фрагментов: 100');
        expect(requests.flatMap(row=>row.deletes)).toEqual([]);capped=false;requests=[];
        const result=JSON.parse(await syncRagDb({projectKey:'p'},'/fixture'));
        expect(result).toMatchObject({ok:true,upserted:1,deleted:1,remaining:0});expect(Object.keys(baseline)).toHaveLength(101);
    });

    it('HTML ошибки прокси не попадает в сообщение синхронизации',async()=>{
        local.push({id:'new',hash:'hash-new'});
        fetchMock.mockImplementation(async(_url:string,options?:RequestInit)=>!options?Response.json({ids:baseline}):new Response('<html>internal-secret</html>',{status:502}));
        await expect(syncRagDb({projectKey:'p'},'/fixture')).rejects.toThrow('Синхронизация остановлена (HTTP 502). Сервер временно не принимает изменения.');
    });

    it.each([ 401, 503 ])('Ошибка манифеста (%s) запрещает запись', async (status) => {
        fetchMock.mockResolvedValue(new Response('unavailable', { status }));

        await expect(syncRagDb({ projectKey: 'p' }, '/fixture')).rejects.toThrow(`manifest ${status}`);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Некорректный манифест отклоняется до записи', async () => {
        fetchMock.mockResolvedValue(Response.json({ error: 'invalid-response' }));

        await expect(syncRagDb({ projectKey: 'p' }, '/fixture')).rejects.toThrow('invalid-manifest');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Явно пустой манифест разрешает первичную загрузку', async () => {
        baseline = {};
        const result = JSON.parse(await syncRagDb({ projectKey: 'p' }, '/fixture'));

        expect(result).toMatchObject({ applied: true, upserted: 2, deleted: 0 });
    });

    it('Пробный запуск не создаёт проект в каталоге', async () => {
        mocks.resolveProjectKey.mockResolvedValue(JSON.stringify({ ok: false, error: 'project-not-found' }));
        await syncRagDb({ dryRun: true, createIfMissing: true }, '/fixture');

        expect(mocks.resolveProjectKey).toHaveBeenCalledWith(
            expect.objectContaining({ createIfMissing: false }), '/fixture',
        );
        expect(requests).toEqual([]);
    });

    it.each([
        { ok: true, projectKey: 'p', identityVerified: false, migrationRequired: true },
        { ok: false, error: 'project-instance-unverified' },
        { ok: true, projectKey: 'other', identityVerified: true, instanceId: 'fixture-instance', bindingId: 'fixture-binding' },
    ])('Явный projectKey не разрешает запись без подтверждённого экземпляра: %j', async identity => {
        mocks.resolveProjectKey.mockResolvedValue(JSON.stringify(identity));
        expect(JSON.parse(await syncRagDb({ projectKey: 'p' }, '/fixture'))).toMatchObject({ ok: false, error: 'project-instance-unverified' });
        expect(mocks.locateStore).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Смена экземпляра между manifest и отправкой останавливает запись до HTTP POST', async () => {
        mocks.resolveProjectKey.mockResolvedValueOnce(JSON.stringify({ ok: true, projectKey: 'p', identityVerified: true, instanceId: 'fixture-instance', bindingId: 'fixture-binding' }))
            .mockResolvedValue(JSON.stringify({ ok: true, projectKey: 'p', identityVerified: true, instanceId: 'another-instance', bindingId: 'another-binding' }));
        await expect(syncRagDb({ projectKey: 'p' }, '/fixture')).rejects.toThrow('экземпляра изменилась');
        expect(requests).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
