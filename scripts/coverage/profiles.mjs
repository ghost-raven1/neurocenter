import path from 'node:path';
import {readFile} from 'node:fs/promises';

export const nativeSuites = [
 'feature-flags-gateway.test.cjs','model-chat-gateway.test.cjs','project-embedding-gateway.test.cjs',
 'source-upload-gateway.test.cjs','snapshot-gateway.test.cjs','catalog-requests-gateway.test.cjs',
 'rag-sync-coordinator-gateway.test.cjs','packaging-metadata-gateway.test.cjs','auth-security.mjs',
 'auth-unavailable-gateway.test.cjs','project-reindex-json-gateway.test.cjs',
];
export const integrationSuites = [
 'model-chat-http.test.mjs','model-chat-context-http.test.mjs','model-chat-group-http.test.mjs',
 'model-chat-project-http.test.mjs','model-chat-list-http.test.mjs','model-usage-http.test.mjs',
 'opencode-model-sync-http.test.mjs','platform-rag-quota-http.test.mjs','store-archive-http.test.mjs',
 'asset-source-archive-http.test.mjs','agent-compilation-http.test.mjs','mcp-host-access-http.test.mjs',
 'research-mcp-http.test.mjs','model-chat-research-http.test.mjs','feature-flags-gateway.test.cjs',
 'chat-recovery-postgres.test.mjs',
];
const databaseVariables = [
 'MODEL_CHAT_TEST_ADMIN_URL','MODEL_CHAT_CONTEXT_TEST_ADMIN_URL','MODEL_CHAT_FILES_TEST_ADMIN_URL',
 'MODEL_CHAT_LIST_TEST_ADMIN_URL','MODEL_USAGE_TEST_ADMIN_URL','OPENCODE_MODEL_SYNC_TEST_PG_URL',
 'ASSET_ARCHIVE_TEST_ADMIN_URL','STORE_ARCHIVE_TEST_ADMIN_URL','CATALOG_TEST_PG_URL',
 'CHAT_RECOVERY_TEST_ADMIN_PG_URL',
];

/** The integration profile has no default database or production-object-store fallback. */
export async function integrationConfiguration(environment,root){
 const value=environment.MODEL_CHAT_TEST_ADMIN_URL;
 if(!value)throw Error('--integration requires an explicit caller-owned MODEL_CHAT_TEST_ADMIN_URL.');
 let url;try{url=new URL(value);}catch{throw Error('The integration PostgreSQL URL is invalid.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/postgres'||url.search||url.hash)
  throw Error('Integration PostgreSQL must be an explicitly owned 127.0.0.1 port other than5432, database /postgres.');
 const env=Object.fromEntries(databaseVariables.map(name=>[name,value])),suites=[...integrationSuites],excludedSuites=[];
 let storage=null;
 if(environment.MODEL_CHAT_TEST_STORAGE_CONFIG){
  const filename=path.resolve(root,environment.MODEL_CHAT_TEST_STORAGE_CONFIG);
  let config;try{config=JSON.parse(await readFile(filename,'utf8'));}catch{throw Error('Cannot read the explicit integration storage configuration.');}
  let endpoint;try{endpoint=new URL(config.CHAT_S3_ENDPOINT);}catch{throw Error('Integration storage endpoint is invalid.');}
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.port==='19010'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)
   throw Error('Integration S3 must use an explicitly owned local endpoint; the main19010 endpoint is forbidden.');
  for(const key of ['CHAT_S3_ACCESS_KEY','CHAT_S3_SECRET_KEY','CHAT_S3_REGION','CHAT_S3_PROJECT_BUCKET','CHAT_S3_PERSONAL_BUCKET'])
   if(typeof config[key]!=='string'||!config[key].trim())throw Error('Incomplete integration storage configuration.');
  if(config.CHAT_S3_PROJECT_BUCKET===config.CHAT_S3_PERSONAL_BUCKET)throw Error('Integration storage requires distinct private project and personal buckets.');
  env.MODEL_CHAT_TEST_STORAGE_CONFIG=filename;suites.push('model-chat-files-http.test.mjs');
  storage={endpoint:endpoint.origin,projectBucket:config.CHAT_S3_PROJECT_BUCKET,personalBucket:config.CHAT_S3_PERSONAL_BUCKET};
 }else excludedSuites.push({file:'model-chat-files-http.test.mjs',reason:'Explicit MODEL_CHAT_TEST_STORAGE_CONFIG was not supplied; S3 document flows were not executed.'});
 return {env,suites,excludedSuites,fixture:{postgres:{host:url.hostname,port:Number(url.port),database:'postgres'},storage}};
}

/** Strip caller infrastructure before unit/native runs, including test-only admin URLs. */
export function safeEnvironment(environment=process.env,nodeExecutable=process.execPath){
 const env={...environment,NODE_ENV:'test',PATH:path.dirname(nodeExecutable)+path.delimiter+(environment.PATH||'')};
 for(const key of Object.keys(env))if(/(?:PG_URL|DATABASE_URL|S3|MINIO|STORAGE_CONFIG|NODE_V8_COVERAGE|TEST.*(?:URL|CONFIG))|^PG[A-Z]/.test(key))delete env[key];
 return env;
}

/** A missing TAP footer is an incomplete result, never an inferred zero-test success. */
export function tapCounts(log){
 const count=key=>{const match=log.match(new RegExp('^# '+key+' (\\d+)$','m'));return match?Number(match[1]):null;};
 return {passed:count('pass'),failed:count('fail'),skipped:count('skipped'),cancelled:count('cancelled'),todo:count('todo')};
}

const knownCount=value=>Number.isSafeInteger(value)&&value>=0;

/** Legacy reports keep unknown counters; only explicit zero omissions prove suite completion. */
export function suiteCountersComplete(item,native=false){
 const keys=['passed','failed','skipped','todo',...(native?['cancelled']:[])];
 return !!item&&keys.every(key=>knownCount(item[key]))&&item.exitCode===0
  &&item.failed===0&&item.skipped===0&&item.todo===0&&(!native||item.cancelled===0)
  &&(!Object.hasOwn(item,'cancelled')||item.cancelled===0);
}

/** Preserve each retained HTTP profile separately: overlapping runs are never unique-test totals. */
export function retainedCoverageProfiles(manifest,depth=0){
 if(depth>8)throw Error('Coverage retained profile nesting exceeds the bounded report scope.');
 const rows=[];
 if(manifest.native||manifest.integration)rows.push({native:manifest.native??null,integration:manifest.integration??null});
 if(Array.isArray(manifest.retainedProfiles))rows.push(...manifest.retainedProfiles);
 else if(Array.isArray(manifest.inputs))for(const input of manifest.inputs)rows.push(...retainedCoverageProfiles(input,depth+1));
 if(rows.length>64)throw Error('Coverage retained profiles exceed the bounded report scope.');
 return rows;
}

/** Recheck requested-suite evidence before retaining a completion claim across merges. */
export function coverageCountersComplete(manifest){
 return Array.isArray(manifest.packages)&&manifest.packages.every(item=>suiteCountersComplete(item)
  &&item.testFileInventory?.complete===true&&item.reportValidation?.ok===true)
  &&retainedCoverageProfiles(manifest).every(row=>[row.native,row.integration].filter(Boolean).every(item=>suiteCountersComplete(item,true)
   &&Array.isArray(item.excludedSuites)&&item.excludedSuites.length===0));
}
