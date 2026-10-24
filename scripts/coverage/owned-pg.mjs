import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../services/shared/feature-flags.cjs';
import {integrationConfiguration} from './profiles.mjs';

export const ownedPgPackages=['catalog-service','rag-sync-service','feature-flags-service'];
export const ownedPgAliases=['CATALOG_TEST_PG_URL','TEST_ADMIN_PG_URL','CHAT_OBJECT_STORAGE_TEST_PG_URL','MODEL_CHAT_FILES_TEST_PG_URL',
 'MODEL_CHAT_GROUP_TEST_PG_URL','MODEL_CHAT_RESEARCH_TEST_PG_URL','AGENT_READINESS_TEST_PG_URL','MODEL_USAGE_TEST_PG_URL','OPENCODE_MODEL_SYNC_TEST_PG_URL','RAG_CONTRACT_TEST_PG_URL','LEARNING_TEST_ADMIN_PG_URL',
 'DEVICE_CODEX_GUARD_TEST_ADMIN_URL','SYSTEM_ROLE_QUEUE_TEST_ADMIN_URL','PROJECT_CHAT_LEARNING_TEST_ADMIN_URL','PERSONAL_GROUP_BRIDGE_TEST_PG_URL',
 'DEVICE_LATE_COMPLETION_TEST_ADMIN_URL','RAG_AUTHORIZATION_TEST_ADMIN_PG_URL','CHAT_ACTIVITY_TEST_ADMIN_URL',
 'PROJECT_CHAT_TEST_ADMIN_URL','DISCUSSIONS_TEST_ADMIN_PG_URL','AGENT_TEST_ADMIN_URL'];

/** Full database suites run only against an explicit caller-owned server; all runtime fallbacks use our own random database. */
export async function ownedPgConfiguration(environment,root){
 const config=await integrationConfiguration(environment,root);
 if(!config.fixture.storage)throw Error('--owned-pg requires an explicit MODEL_CHAT_TEST_STORAGE_CONFIG.');
 const disk=await statfs(root,{bigint:true});if(disk.bavail*disk.bsize<=8n*1024n**3n)throw Error('Full PostgreSQL/S3 coverage requires more than8GiB free disk space.');
 return config;
}
export async function startOwnedPg(config){
 const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url)),{Pool}=require('pg');
 const adminUrl=config.env.MODEL_CHAT_TEST_ADMIN_URL,admin=new Pool({connectionString:adminUrl,max:1,connectionTimeoutMillis:3000});
 const database='nc_cov_'+randomUUID().replaceAll('-',''),url=new URL(adminUrl);url.pathname='/'+database;
 const token=randomBytes(32).toString('hex');
 const flags=createServer((req,res)=>{
  if(req.url!=='/internal/feature-flags/evaluated'||req.headers['x-neurocenter-internal']!==token){res.writeHead(403).end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(evaluateFeatureFlags(defaultFeatureFlags())));
 });
 let created=false;
 try{
  await admin.query('CREATE DATABASE '+database);created=true;
  await new Promise((resolve,reject)=>{flags.once('error',reject);flags.listen(0,'127.0.0.1',resolve);});
 }catch(error){if(created)await admin.query('DROP DATABASE '+database);await admin.end();throw error;}
 const env={...Object.fromEntries(ownedPgAliases.map(name=>[name,adminUrl])),CATALOG_PG_URL:url.href,RAG_PG_URL:url.href,RAG_PROVISION_PG_URL:url.href,
  PGHOST:new URL(adminUrl).hostname,PGPORT:new URL(adminUrl).port,PGDATABASE:database,PGUSER:decodeURIComponent(new URL(adminUrl).username),PGPASSWORD:decodeURIComponent(new URL(adminUrl).password),
  MODEL_CHAT_TEST_STORAGE_CONFIG:config.env.MODEL_CHAT_TEST_STORAGE_CONFIG,MODEL_CHAT_FILES_TEST_S3_CONFIG:config.env.MODEL_CHAT_TEST_STORAGE_CONFIG,
  CHAT_OBJECT_STORAGE_TEST_CONFIG:config.env.MODEL_CHAT_TEST_STORAGE_CONFIG,FEATURE_FLAGS_SERVICE_URL:'http://127.0.0.1:'+flags.address().port,
  NEUROCENTER_INTERNAL_TOKEN:token,NEUROCENTER_MODEL_CREDENTIAL_KEY:randomBytes(32).toString('base64')};
 return {env,fixture:{...config.fixture,fallbackDatabase:database,aliases:[...ownedPgAliases,'CATALOG_PG_URL','RAG_PG_URL','RAG_PROVISION_PG_URL'],flags:'Owned local evaluated snapshot; per-test off/revoke mocks remain independent.'},
  async close(){flags.closeAllConnections();await new Promise(resolve=>flags.close(resolve));try{await admin.query('DROP DATABASE '+database);}finally{await admin.end();}}};
}
