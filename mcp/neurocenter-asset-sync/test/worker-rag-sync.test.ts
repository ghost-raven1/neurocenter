import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {syncRagDb} from '../src/tools/sync-rag-db.js';
import {restoreRagDb} from '../src/tools/restore-rag-db.js';
import {projectFolder,safeTarget} from '../src/bridge/workspace.js';
import {locateStore} from '../src/lib/store.js';
import {runRagBridgeJob} from '../src/bridge/rag-worker.js';

vi.mock('../src/tools/sync-rag-db.js',()=>({syncRagDb:vi.fn()}));
vi.mock('../src/tools/restore-rag-db.js',()=>({restoreRagDb:vi.fn()}));
vi.mock('../src/bridge/workspace.js',()=>({projectFolder:vi.fn(),safeTarget:vi.fn()}));
vi.mock('../src/lib/store.js',()=>({locateStore:vi.fn()}));
const job={kind:'sync-rag' as const,projectId:'project',bindingId:'b'.repeat(64)};
const outcome={ok:true,applied:true,complete:true,remaining:0,projectKey:job.projectId,fingerprintVersion:1,
    indexProfile:{provider:'ollama',model:'fixture',dimension:3},snapshotHash:'a'.repeat(64),dimension:3,
    localCount:1250,upserted:250,deleted:0,appliedNow:250,written:1250};

describe('Мост отправляет полный индекс последовательными ограниченными порциями',()=>{
    let folder:string;
    const authorize=vi.fn(),update=vi.fn();
    beforeEach(async()=>{
        vi.resetAllMocks();folder=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-rag-worker-'));
        vi.mocked(projectFolder).mockResolvedValue(folder);vi.mocked(safeTarget).mockResolvedValue(path.join(folder,'.opencode/rag_db'));
        vi.mocked(locateStore).mockResolvedValue({storePath:path.join(folder,'.opencode/rag_db')} as never);
        authorize.mockResolvedValue(undefined);update.mockResolvedValue(undefined);
        vi.mocked(syncRagDb).mockResolvedValue(JSON.stringify(outcome));vi.mocked(restoreRagDb).mockResolvedValue(JSON.stringify(outcome));
    });
    afterEach(async()=>{await fs.rm(folder,{recursive:true,force:true});});
    it('1250 изменений проходят за три вызова по 500 до подтверждённого seal',async()=>{
        vi.mocked(syncRagDb).mockResolvedValueOnce(JSON.stringify({...outcome,upserted:500,appliedNow:500,remaining:750,complete:false}))
            .mockResolvedValueOnce(JSON.stringify({...outcome,upserted:500,appliedNow:500,remaining:250,complete:false}));
        const result=await runRagBridgeJob(job,authorize,update);
        expect(syncRagDb).toHaveBeenCalledTimes(3);
        for(const args of vi.mocked(syncRagDb).mock.calls) expect(args).toEqual([{projectKey:'project',project:folder,limit:500},folder,authorize]);
        expect(result).toMatchObject({ok:true,complete:true,remaining:0,upserted:1250,batches:3,bindingId:job.bindingId});
        expect(update.mock.calls.map(([percent])=>percent)).toEqual([38,76,99]);
    });
    it.each([{appliedNow:0,remaining:2,complete:false},{complete:false},{localCount:0},{snapshotHash:''},{preview:true},{applied:false}])('Нулевой или неподтверждённый результат не завершает задание: %j',change=>{
        vi.mocked(syncRagDb).mockResolvedValue(JSON.stringify({...outcome,...change}));
        return expect(runRagBridgeJob(job,authorize,update)).rejects.toThrow();
    });
    it('Уже совпадающий непустой индекс подтверждается без лишнего повторения',async()=>{
        vi.mocked(syncRagDb).mockResolvedValue(JSON.stringify({...outcome,appliedNow:0,upserted:0,deleted:0}));
        await expect(runRagBridgeJob(job,authorize,update)).resolves.toMatchObject({complete:true,remaining:0,batches:1});
        expect(syncRagDb).toHaveBeenCalledOnce();
    });
    it('Отзыв доступа или смена папки между порциями останавливает отправку',async()=>{
        vi.mocked(syncRagDb).mockResolvedValue(JSON.stringify({...outcome,upserted:500,appliedNow:500,remaining:750,complete:false}));
        authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Папка изменилась'));
        await expect(runRagBridgeJob(job,authorize,update)).rejects.toThrow('Папка изменилась');
        expect(syncRagDb).toHaveBeenCalledOnce();
    });
    it('Фоновая индексация между порциями не превращает разные snapshot в один успех',async()=>{
        vi.mocked(syncRagDb).mockResolvedValueOnce(JSON.stringify({...outcome,upserted:500,appliedNow:500,remaining:750,complete:false}))
            .mockResolvedValueOnce(JSON.stringify({...outcome,snapshotHash:'c'.repeat(64)}));
        await expect(runRagBridgeJob(job,authorize,update)).rejects.toThrow('между пакетами');
    });
    it('Повтор без уменьшения остатка не зацикливает очередь',async()=>{
        vi.mocked(syncRagDb).mockResolvedValue(JSON.stringify({...outcome,upserted:500,appliedNow:500,remaining:750,complete:false}));
        await expect(runRagBridgeJob(job,authorize,update)).rejects.toThrow('продвижение');
        expect(syncRagDb).toHaveBeenCalledTimes(2);
    });
    it('Восстановление передаёт авторизацию до локального commit и исключает абсолютные пути из квитанции',async()=>{
        vi.mocked(restoreRagDb).mockResolvedValue(JSON.stringify({...outcome,storePath:path.join(folder,'.opencode/rag_db')}));
        const result=await runRagBridgeJob({...job,kind:'restore-rag'},authorize,update);
        expect(restoreRagDb).toHaveBeenCalledExactlyOnceWith({projectKey:'project',project:folder},folder,authorize);
        expect(result).toMatchObject({complete:true,bindingId:job.bindingId,written:1250});
        expect(result).not.toHaveProperty('storePath');expect(JSON.stringify(result)).not.toContain(folder);
    });
});
