import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startOwnedPg} from '../coverage/owned-pg.mjs';
import {safeEnvironment} from '../coverage/profiles.mjs';

const adminUrl=process.env.COVERAGE_OWNED_TEST_ADMIN_URL;
const consumers=['DEVICE_LATE_COMPLETION_TEST_ADMIN_URL','RAG_AUTHORIZATION_TEST_ADMIN_PG_URL',
 'CHAT_ACTIVITY_TEST_ADMIN_URL','PROJECT_CHAT_TEST_ADMIN_URL','DISCUSSIONS_TEST_ADMIN_PG_URL','AGENT_TEST_ADMIN_URL'];

/** Exercise effective consumer connections and fixture cleanup on an explicitly owned server. */
test('Owned coverage connects every database consumer and removes only its fallback database', {skip:!adminUrl,timeout:15000}, async()=>{
 const selected=new URL(adminUrl);
 assert.ok(['postgres:','postgresql:'].includes(selected.protocol)&&selected.hostname==='127.0.0.1'
  &&selected.port&&selected.port!=='5432'&&selected.pathname==='/postgres'&&!selected.search&&!selected.hash,
 'Use only an explicit owned loopback PostgreSQL admin connection.');
 const {Pool}=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url))('pg');
 const admin=new Pool({connectionString:adminUrl,max:1,connectionTimeoutMillis:3000,query_timeout:3000});
 const databases=async()=>(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
 let before,fixture;
 try{
  before=await databases();
  fixture=await startOwnedPg({env:{MODEL_CHAT_TEST_ADMIN_URL:adminUrl},fixture:{postgres:{host:'127.0.0.1',port:Number(selected.port)}}});
  const inherited=Object.fromEntries(consumers.map(name=>[name,'postgresql://forbidden:forbidden@127.0.0.1:5432/catalog']));
  const effective={...safeEnvironment({...inherited,CATALOG_PG_URL:inherited[consumers[0]]}),...fixture.env};
  for(const name of consumers){
   assert.ok(effective[name]===adminUrl,name+' must use the explicitly owned server instead of skipping or inheriting another database.');
   const consumer=new Pool({connectionString:effective[name],max:1,connectionTimeoutMillis:3000,query_timeout:3000});
   try{assert.equal((await consumer.query('SELECT current_database() AS name')).rows[0].name,'postgres');}
   finally{await consumer.end();}
  }
  const runtime=new Pool({connectionString:effective.CATALOG_PG_URL,max:1,connectionTimeoutMillis:3000,query_timeout:3000});
  try{assert.equal((await runtime.query('SELECT current_database() AS name')).rows[0].name,fixture.fixture.fallbackDatabase);}
  finally{await runtime.end();}
  assert.match(fixture.fixture.fallbackDatabase,/^nc_cov_[a-f0-9]{32}$/);
  assert.ok((await databases()).includes(fixture.fixture.fallbackDatabase));
  assert.ok(!decodeURIComponent(selected.password)||!JSON.stringify(fixture.fixture).includes(decodeURIComponent(selected.password)),
   'Public fixture metadata must not include credentials.');
 }finally{
  try{await fixture?.close();if(before)assert.deepEqual(await databases(),before,'All pre-existing databases must survive fixture cleanup.');}
  finally{await admin.end();}
 }
});
