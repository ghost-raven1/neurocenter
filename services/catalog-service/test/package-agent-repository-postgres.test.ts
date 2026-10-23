import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {PackageBuildRepository} from '../src/package-build/package-build.repository';
import {BuildCancelledError} from '../src/package-build/build-cancellation';
import type {BuildRuntimeReport} from '../src/package-build/build-runtime';

const connection=process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!connection)('Packager repository fences on caller-owned PostgreSQL',()=>{
    let pool:Pool,admin:Pool,database:string,repository:PackageBuildRepository;
    beforeAll(async()=>{
        const url=ownedTestPostgresAdmin(connection);admin=new Pool({connectionString:url.href,max:1});
        database='nc_packager_fence_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);
        url.pathname='/'+database;pool=new Pool({connectionString:url.href,max:3});await ensureCatalogSchema(pool);repository=new PackageBuildRepository(pool);
    });
    afterEach(async()=>{if(pool)await pool.query('DELETE FROM tool_build_jobs');});
    afterAll(async()=>{if(pool)await pool.end();if(admin){try{if(database)await admin.query('DROP DATABASE IF EXISTS '+database);}finally{await admin.end();}}});
    const running=async()=>{
        const id=randomUUID(),nonce=randomUUID();
        await pool.query("INSERT INTO tool_build_jobs(id,actor,request_key,request_hash,config,state,message,execution_nonce,execution_started) VALUES($1,'owner@localhost',$2,'fixture','{}','RUNNING','Fixture',$3,true)",[id,randomUUID(),nonce]);
        return {id,nonce};
    };
    const report={schemaVersion:1,ok:false,status:'failed',diagnostics:[]} as unknown as BuildRuntimeReport;

    it('rotates only the current running nonce and resets its execution acknowledgment',async()=>{
        const row=await running(),lease=await pool.connect();
        try{
            const next=await repository.nextAttempt(row.id,row.nonce,lease);expect(next).not.toBe(row.nonce);
            expect((await pool.query('SELECT execution_nonce,execution_started FROM tool_build_jobs WHERE id=$1',[row.id])).rows[0]).toEqual({execution_nonce:next,execution_started:false});
            await expect(repository.nextAttempt(row.id,row.nonce,lease)).rejects.toThrow('владельца');
            expect((await pool.query('SELECT execution_nonce FROM tool_build_jobs WHERE id=$1',[row.id])).rows[0].execution_nonce).toBe(next);
        }finally{lease.release();}
    });
    it('rejects stale, cancelled, finished and publication-started owners before recording or rotating',async()=>{
        const row=await running(),lease=await pool.connect();
        try{
            await expect(repository.recordRuntime(row.id,randomUUID(),1,report,lease)).rejects.toThrow('владельца');
            for(const state of ['CANCELLING','CANCELLED','FAILED']){
                await pool.query('UPDATE tool_build_jobs SET state=$2 WHERE id=$1',[row.id,state]);
                const next=repository.nextAttempt(row.id,row.nonce,lease);
                if(state.startsWith('CANCEL'))await expect(next).rejects.toBeInstanceOf(BuildCancelledError);else await expect(next).rejects.toThrow('владельца');
                await expect(repository.recordRuntime(row.id,row.nonce,1,report,lease)).rejects.toThrow();
            }
            await pool.query("UPDATE tool_build_jobs SET state='RUNNING',publication_started_at=now() WHERE id=$1",[row.id]);
            await expect(repository.nextAttempt(row.id,row.nonce,lease)).rejects.toThrow('владельца');
            await expect(repository.recordRuntime(row.id,row.nonce,1,report,lease)).rejects.toThrow('владельца');
            expect((await pool.query('SELECT * FROM tool_build_runtime_checks')).rows).toEqual([]);
        }finally{lease.release();}
    });
    it('retains each attempt and fences a late verifier after the next builder owns the job',async()=>{
        const row=await running(),lease=await pool.connect();
        try{
            await repository.recordRuntime(row.id,row.nonce,1,report,lease);
            const next=await repository.nextAttempt(row.id,row.nonce,lease);
            await expect(repository.recordRuntime(row.id,row.nonce,2,report,lease)).rejects.toThrow('владельца');
            await repository.recordRuntime(row.id,next,2,report,lease);
            await expect(repository.recordRuntime(row.id,next,2,report,lease)).rejects.toThrow();
            expect((await pool.query('SELECT attempt,execution_nonce FROM tool_build_runtime_checks ORDER BY attempt')).rows).toEqual([{attempt:1,execution_nonce:row.nonce},{attempt:2,execution_nonce:next}]);
        }finally{lease.release();}
    });
});
