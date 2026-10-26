import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {createQaPostgres,inspectQaPostgres,closeQaPostgres,loadQaPostgres} from '../../qa/postgres-runtime.mjs';
import {probePostgresSql,observePostgresProcess} from '../../qa/postgres-process.mjs';
import {admitManagedPostgres} from '../../qa/postgres-admission.mjs';
import {main as postgresMain} from '../../qa/postgres.mjs';

const root=path.resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const bin=process.env.QA_POSTGRES_TEST_BIN;
const require=createRequire(path.join(root,'services/catalog-service/package.json'));

/** Poll a real observable transition; fixed sleeps do not establish PostgreSQL readiness. */
async function until(action,label){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){const value=await action();if(value)return value;await delay(30);}
    throw Error('Owned PostgreSQL did not reach '+label);
}

async function cluster(t){
    const result=await createQaPostgres(root,{binDirectory:bin,leaseSeconds:3600});
    t.diagnostic('Owned run '+result.runId);
    t.after(async()=>{
        const stopped=await closeQaPostgres(root,result.runId);
        assert.equal(stopped.stopped,true,'Every created cluster must be proven stopped.');
    });
    assert.equal(result.ready,true,'Explicit PostgreSQL binaries must produce a ready private fixture.');
    return result;
}

test('two real clusters have distinct ports and flag-off shutdown preserves the other cluster',
    {skip:!bin,timeout:60000},async t=>{
        const first=await cluster(t),second=await cluster(t);
        assert.notEqual(first.runId,second.runId);assert.notEqual(first.port,second.port);
        assert.notEqual(first.port,5432);assert.notEqual(second.port,5432);
        const admitted=await admitManagedPostgres(first.connectionFile,{root});
        assert.equal(admitted.proof.sql,true);assert.equal(admitted.proof.sqlState,'matched');
        let printed='';
        const code=await postgresMain(['close','--run',first.runId],{
            environment:{NEUROCENTER_QA_POSTGRES:'0'},output:{write:value=>{printed+=value;}},
        });
        assert.equal(code,0);assert.equal(JSON.parse(printed).stopped,true);
        assert.equal((await inspectQaPostgres(root,second.runId)).ready,true);
        assert.equal((await closeQaPostgres(root,first.runId)).stopped,true,'Repeated close is idempotent.');
        await assert.rejects(admitManagedPostgres(second.connectionFile,{root,environment:{NEUROCENTER_QA_POSTGRES:'0'}}),
            error=>error.code==='QA_DISABLED');
        assert.equal((await inspectQaPostgres(root,second.runId)).ready,true,'Disabling new admission preserves inspection.');
    });

test('restored HBA bytes cannot hide active trust authentication or authorize a shutdown signal',
    {skip:!bin,timeout:60000},async t=>{
        const fixture=await createQaPostgres(root,{binDirectory:bin,leaseSeconds:3600});
        t.diagnostic('Owned run '+fixture.runId);
        let hba,original,control,connected=false;
        // Authentication repair and shutdown share one ordered hook.
        t.after(async()=>{
            try{
                if(original)await fs.writeFile(hba,original);
                if(connected){
                    await control.query('SELECT pg_reload_conf()');
                    await until(async()=>(await inspectQaPostgres(root,fixture.runId)).ready,'restored SCRAM');
                }
            }finally{
                await control?.end();
                assert.equal((await closeQaPostgres(root,fixture.runId)).stopped,true);
            }
        });
        assert.equal(fixture.ready,true);
        const loaded=await loadQaPostgres(root,fixture.runId),{Client}=require('pg');
        hba=path.join(loaded.paths.data,'pg_hba.conf');original=await fs.readFile(hba);
        control=new Client({connectionString:loaded.connection.adminUrl,connectionTimeoutMillis:2000,
            query_timeout:2000,options:'',ssl:false});
        control.on('error',()=>{});
        await control.connect();connected=true;
        const before=await observePostgresProcess(loaded.owner.postgresPid);
        assert.equal(before.state,'observed');
        const trust=original.toString('utf8').replaceAll('scram-sha-256','trust');
        assert.notEqual(trust,original.toString('utf8'));
        await fs.writeFile(hba,trust);await control.query('SELECT pg_reload_conf()');
        await until(async()=>!(await probePostgresSql(root,loaded.owner,loaded.connection)).matches,'active trust handshake');
        await fs.writeFile(hba,original); // Deliberately do not reload: file hashes now match, active auth remains trust.
        const mismatched=await inspectQaPostgres(root,fixture.runId);
        assert.equal(mismatched.proof.files,true);assert.equal(mismatched.proof.sqlState,'mismatch');
        assert.equal(mismatched.ownership,'unknown');assert.equal(mismatched.ready,false);
        await assert.rejects(closeQaPostgres(root,fixture.runId),error=>error.code==='QA_OWNERSHIP_UNKNOWN');
        const after=await observePostgresProcess(loaded.owner.postgresPid);
        assert.equal(after.state,'observed');assert.equal(after.identity.birth,before.identity.birth);
        assert.equal((await control.query('SELECT 1 AS alive')).rows[0].alive,1,'The rejected close must send no shutdown signal.');
    });

test('an actual password rejection leaves ownership unknown and cannot authorize a shutdown signal',
    {skip:!bin,timeout:60000},async t=>{
        const fixture=await createQaPostgres(root,{binDirectory:bin,leaseSeconds:3600});
        t.diagnostic('Owned run '+fixture.runId);
        let control,connected=false,password;
        t.after(async()=>{
            try{
                if(connected){
                    await control.query('ALTER ROLE qa_owner PASSWORD '+control.escapeLiteral(password));
                    await until(async()=>(await inspectQaPostgres(root,fixture.runId)).ready,'restored password');
                }
            }finally{
                await control?.end();
                assert.equal((await closeQaPostgres(root,fixture.runId)).stopped,true);
            }
        });
        assert.equal(fixture.ready,true);
        const loaded=await loadQaPostgres(root,fixture.runId),{Client}=require('pg');
        password=decodeURIComponent(new URL(loaded.connection.adminUrl).password);
        control=new Client({connectionString:loaded.connection.adminUrl,connectionTimeoutMillis:2000,
            query_timeout:2000,options:'',ssl:false});
        control.on('error',()=>{});
        await control.connect();connected=true;
        await control.query("ALTER ROLE qa_owner PASSWORD 'changed-for-owned-auth-regression'");
        const observed=await inspectQaPostgres(root,fixture.runId);
        assert.equal(observed.proof.files,true);assert.equal(observed.proof.sqlState,'mismatch');
        assert.equal(observed.ownership,'unknown');assert.equal(observed.ready,false);
        await assert.rejects(closeQaPostgres(root,fixture.runId),error=>error.code==='QA_OWNERSHIP_UNKNOWN');
        assert.equal((await control.query('SELECT 1 AS alive')).rows[0].alive,1);
    });
