import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(repo,'services/catalog-service/package.json'));
const {Pool}=require('pg'),sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ownDatabaseName=projectId=>'nc_rag_'+createHash('sha256').update(projectId).digest('hex').slice(0,32);
/** Every SQL statement is read-only; this helper never provisions or drops a PostgreSQL database. */
export async function databaseProof(receiptFile,connectionString='postgresql://rag:rag@127.0.0.1:5432/postgres'){
 const source=JSON.parse(await fs.readFile(receiptFile,'utf8')),baseline=[...source.databasesBefore].sort();assert.equal(baseline.length,24);assert.equal(new Set(baseline).size,24);
 const url=new URL(connectionString);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');
 const pools=new Map();
 function pool(database){if(!pools.has(database)){const target=new URL(url);target.pathname='/'+database;pools.set(database,new Pool({connectionString:target.href,max:1,statement_timeout:10000,connectionTimeoutMillis:5000}));}return pools.get(database);}
 async function read(database,sql,args=[]){const client=await pool(database).connect();try{await client.query('BEGIN READ ONLY');const rows=(await client.query(sql,args)).rows;await client.query('COMMIT');return rows;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}
 async function names(){return (await read('postgres','SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).map(row=>row.datname);}
 async function oldState(){
  const registry=await read('rag','SELECT project_id,to_jsonb(r) AS row FROM neurocenter_project_databases r WHERE database_name=ANY($1::text[]) ORDER BY project_id',[baseline]);
  const retirements=await read('catalog','SELECT to_jsonb(r) AS row FROM project_retirements r WHERE project_id=ANY($1::text[]) ORDER BY project_id',[registry.map(row=>row.project_id)]);
  return {registryCount:registry.length,registrySha256:sha(registry),retirementCount:retirements.length,retirementSha256:sha(retirements)};
 }
 async function compare(){const actual=await names();const originalDatabaseOids=await read('postgres','SELECT datname,oid::text AS oid FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname',[baseline]);return {baseline,actual,originalDatabaseOids,added:actual.filter(name=>!baseline.includes(name)),missing:baseline.filter(name=>!actual.includes(name)),oldState:await oldState()};}
 return {baseline,compare,names,async ownRegistry(projectId){return (await read('rag','SELECT project_id,database_name,lifecycle_state FROM neurocenter_project_databases WHERE project_id=$1',[projectId]))[0]??null;},async close(){await Promise.all([...pools.values()].map(value=>value.end()));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const proof=await databaseProof(process.argv[2]||path.join(repo,'.run/agents-activation-20261021/backup-receipt.json'),process.env.AGENT_ACCEPTANCE_PG_URL);
 try{console.log(JSON.stringify(await proof.compare(),null,2));}finally{await proof.close();}
}
