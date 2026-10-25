import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {safeEnvironment} from '../coverage/profiles.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const consumers=['SYSTEM_ROLE_CHAT_TEST_ADMIN_URL','SYSTEM_ROLE_MCP_TEST_ADMIN_URL','SYSTEM_ROLE_MCP_CHANNEL_TEST_ADMIN_URL'];

/** Exercise the actual owned-PG environment/cleanup while replacing only the PostgreSQL driver boundary. */
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-owned-env-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const name of ['scripts/coverage/owned-pg.mjs','scripts/coverage/profiles.mjs','services/shared/feature-flags.cjs','services/shared/feature-flag-catalog.json']){
  const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(repository,name),target);
 }
 const catalog=path.join(root,'services/catalog-service');await fs.mkdir(path.join(catalog,'node_modules/pg'),{recursive:true});
 await fs.writeFile(path.join(catalog,'package.json'),'{}');
 await fs.writeFile(path.join(catalog,'node_modules/pg/index.js'),`const events=[];
 class Pool{
  constructor(options){events.push({kind:'connect',options});}
  async query(sql){if(!/^(?:CREATE|DROP) DATABASE nc_cov_[a-f0-9]{32}$/.test(sql))throw Error('Unexpected fixture SQL');events.push({kind:'query',sql});return {rows:[]};}
  async end(){events.push({kind:'end'});}
 }
 module.exports={Pool,events};\n`);
 const pg=createRequire(path.join(catalog,'package.json'))('pg');
 return{pg,...await import(pathToFileURL(path.join(root,'scripts/coverage/owned-pg.mjs')).href)};
}

test('Owned coverage supplies every service-chat/MCP consumer from its admitted server after removing unsafe caller aliases',async t=>{
 const f=await fixture(t),owned='postgresql://qa:synthetic-private@127.0.0.1:59616/postgres';
 const caller=Object.fromEntries(consumers.map(name=>[name,'postgresql://forbidden:forbidden@127.0.0.1:5432/catalog']));
 const clean=safeEnvironment(caller);for(const name of consumers)assert.equal(name in clean,false,name);
 const ownedFixture=await f.startOwnedPg({env:{MODEL_CHAT_TEST_ADMIN_URL:owned},fixture:{postgres:{host:'127.0.0.1',port:59616}}});
 try{
  const effective={...clean,...ownedFixture.env};
  assert.deepEqual(Object.fromEntries(consumers.map(name=>[name,effective[name]])),Object.fromEntries(consumers.map(name=>[name,owned])));
  for(const name of consumers)assert.ok(ownedFixture.fixture.aliases.includes(name),name+' is retained in fixture metadata');
  assert.equal(JSON.stringify(ownedFixture.fixture).includes('synthetic-private'),false);
  const response=await fetch(ownedFixture.env.FEATURE_FLAGS_SERVICE_URL+'/internal/feature-flags/evaluated',{headers:{'x-neurocenter-internal':ownedFixture.env.NEUROCENTER_INTERNAL_TOKEN}});
  assert.equal(response.status,200);assert.ok(await response.json());
 }finally{await ownedFixture.close();}
 const created=f.pg.events.find(event=>event.kind==='query');
 assert.deepEqual(f.pg.events,[{kind:'connect',options:{connectionString:owned,max:1,connectionTimeoutMillis:3000}},created,{kind:'query',sql:created.sql.replace('CREATE','DROP')},{kind:'end'}]);
});
