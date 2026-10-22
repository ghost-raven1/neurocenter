import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {ensureCatalogSchema} from '../src/database/catalog-schema';

export const connection=process.env.LEARNING_TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL;
/** Reject libpq query overrides and non-administrative databases before any Pool or network call. */
export function ownedLearningTestAdminUrl(value:string|undefined):URL{
    let url:URL;try{url=new URL(value??'');}catch{throw Error('Explicit owned learning PostgreSQL admin URL required.');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/postgres'||url.search||url.hash)throw Error('Explicitly owned loopback PostgreSQL admin URL on a non-default port required before CREATE DATABASE.');
    return url;
}
/** Lifecycle regressions use a UUID database only after explicit owned PostgreSQL admission. */
export async function database(){
    const url=ownedLearningTestAdminUrl(connection);
    const disk=await statfs(process.cwd(),{bigint:true});if(disk.bavail*disk.bsize<4n*1024n**3n)throw Error('Learning fixture disk admission requires4GiB.');
    url.pathname='/postgres';const owner=new Pool({connectionString:url.href,max:1}),name='nc_learning_lifecycle_'+randomUUID().replaceAll('-','');
    await owner.query('CREATE DATABASE '+name);url.pathname='/'+name;const pool=new Pool({connectionString:url.href,max:8});
    try{await ensureCatalogSchema(pool);}catch(error){await pool.end();try{await owner.query('DROP DATABASE '+name);}finally{await owner.end();}throw error;}
    return{pool,async close(){await pool.end();try{await owner.query('DROP DATABASE '+name);}finally{await owner.end();}}};
}
