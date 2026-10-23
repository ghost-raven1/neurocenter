import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

const require=createRequire(import.meta.url),root=fileURLToPath(new URL('..',import.meta.url));
const fixture=fileURLToPath(new URL('./postgres-disconnect.fixture.cjs',import.meta.url));

/** A real uncaught client.error must kill only the owned child, never the Vitest worker. */
function run(scenario:string):Promise<{code:number|null;signal:string|null;stdout:string;stderr:string;result:Record<string,unknown>}>{
    return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['-r',require.resolve('ts-node/register/transpile-only'),fixture,scenario],{
            cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'test',TS_NODE_PROJECT:fileURLToPath(new URL('../tsconfig.json',import.meta.url))},
            stdio:['ignore','pipe','pipe'],
        });
        let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
        const watchdog=setTimeout(()=>child.kill('SIGKILL'),10000);
        child.once('error',error=>{clearTimeout(watchdog);reject(error);});
        child.once('close',(code,signal)=>{
            clearTimeout(watchdog);const line=stdout.split('\n').find(value=>value.startsWith('POSTGRES_FIXTURE_RESULT '));
            resolve({code,signal,stdout,stderr,result:line?JSON.parse(line.slice('POSTGRES_FIXTURE_RESULT '.length)):{}});
        });
    });
}

describe('PostgreSQL disconnects at the real pg.Client socket boundary',()=>{
    it('A pool.error listener alone still crashes a checked-out idle client (positive control)',async()=>{
        const child=await run('unguarded');
        expect(child.signal).toBeNull();expect(child.code).not.toBe(0);
        expect(child.stderr.replaceAll('\\','/')).toContain('pg/lib/client.js');expect(child.stderr).toContain('Connection terminated unexpectedly');
    },15000);
    it.each(['borrowed-idle','in-flight'])('%s preserves process, query failure and owner release without retry',async scenario=>{
        const child=await run(scenario);
        expect(child.stderr).toBe('');expect(child.code,child.stdout).toBe(0);expect(child.signal).toBeNull();
        expect(child.result).toMatchObject({releasesAtDisconnect:0,releasesAfterOwner:1,connectionsAtDisconnect:1,connectionBeforeExplicitQuery:1,connectionsAfterExplicitQuery:2,value:1});
        expect(child.result.laterRejected).toMatch(/not queryable|closed/);
        expect(child.result.queries).toEqual(scenario==='in-flight'?['SELECT 1','SELECT 1']:['SELECT 1']);
        if(scenario==='in-flight')expect(child.result.rejected).toBe('Connection terminated unexpectedly');
    },15000);
    it('An owner can still abort and discard its client from its own error listener',async()=>{
        const child=await run('owner-abort');
        expect(child.stderr).toBe('');expect(child.code,child.stdout).toBe(0);
        expect(child.result).toMatchObject({aborted:true,releasesAtDisconnect:1,releasesAfterOwner:1,connectionsAtDisconnect:1,connectionsAfterExplicitQuery:2,value:1});
    },15000);
    it('A released idle client is removed by pg and the next explicit query obtains a new connection',async()=>{
        const child=await run('pool-idle');
        expect(child.stderr).toBe('');expect(child.code,child.stdout).toBe(0);
        expect(child.result).toMatchObject({releasesAtDisconnect:1,releasesAfterOwner:1,connectionsAtDisconnect:1,connectionBeforeExplicitQuery:1,connectionsAfterExplicitQuery:2,value:1});
    },15000);
    it.each([['remote-healthy',123],['remote-eof',0]])('The raw remoteDbSize owner handles %s and closes its single connection',async(scenario,value)=>{
        const child=await run(String(scenario));
        expect(child.stderr).toBe('');expect(child.code,child.stdout).toBe(0);expect(child.signal).toBeNull();
        expect(child.result).toEqual({value,connections:1,closedConnections:1,queries:['SELECT pg_database_size(current_database())::float8 AS sz']});
    },15000);
});
