import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
export const connection=process.env.CATALOG_TEST_PG_URL;
export const main={email:'main@fixture.test',activeRole:'Главный админ'},admin={email:'admin@fixture.test',activeRole:'Админ проекта'},developer={email:'dev@fixture.test',activeRole:'Разработчик'};
export const definition={description:'Проверяет проект',prompt:'Проверь код и сообщи о подтверждённых проблемах.',mode:'subagent' as const,permission:{read:'allow' as const,edit:'ask' as const}};
export async function database(){
 const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Disposable localhost PostgreSQL required');
 url.pathname='/postgres';const owner=new Pool({connectionString:url.href,max:1}),name='nc_agents_'+randomUUID().replaceAll('-','');
 await owner.query('CREATE DATABASE '+name);url.pathname='/'+name;const pool=new Pool({connectionString:url.href,max:8});
 try{await ensureCatalogSchema(pool);}catch(error){await pool.end();await owner.query('DROP DATABASE '+name);await owner.end();throw error;}
 return {pool,async close(){await pool.end();await owner.query('DROP DATABASE '+name);await owner.end();}};
}
export async function reset(pool:Pool){
 await pool.query('TRUNCATE projects,agent_catalog,agent_mutation_requests,platform_users,bridge_devices,security_events,asset_management_impacts,asset_management_operations,asset_source_receipts,asset_source_versions,asset_source_jobs,operations CASCADE');
 await pool.query("INSERT INTO projects(id,name) VALUES('prj-agents','Agent fixture'),('prj-other','Other project')");
 await pool.query("INSERT INTO platform_users(email,is_main_admin) VALUES($1,true),($2,false),($3,false)",[main.email,admin.email,developer.email]);
 await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-agents',$1,$1,'Admin','Админ проекта'),('prj-agents',$2,$2,'Dev','Разработчик')",[admin.email,developer.email]);
}
