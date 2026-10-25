import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {Pool} from 'pg';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';

/** Explicit non-default loopback admin only; all pools and the UUID database belong to this invocation. */
export async function browserSessionDatabase(connection:string|undefined){
 const disk=await statfs(process.cwd());if(disk.bavail*disk.bsize<=8*1024**3)throw new Error('Owned PostgreSQL acceptance requires more than8GiB free.');
 const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection}),name='nc_browser_session_'+randomUUID().replace(/-/g,'');
 const admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:10000}),pools=new Set<Pool>();
 let created=false;
 const createPool=()=>{const target=new URL(url);target.pathname='/'+name;const pool=new Pool({connectionString:target.href,max:3,connectionTimeoutMillis:5000,statement_timeout:10000});pool.on('error',()=>undefined);pools.add(pool);return pool;};
 try{
  await admin.query('CREATE DATABASE "'+name+'"');created=true;const pool=createPool();
  return {pool,name,createPool,async retire(value:Pool){if(!pools.has(value))throw new Error('Pool is not owned');await value.end();pools.delete(value);},async close(){
   try{for(const pool of pools)await pool.end();pools.clear();await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await admin.end();}
  }};
 }catch(error){try{for(const pool of pools)await pool.end();if(created)await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await admin.end();}throw error;}
}
