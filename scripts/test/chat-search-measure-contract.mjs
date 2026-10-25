/** Measure migration39 only on an explicitly owned non-default loopback PostgreSQL. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),url=ownedTestPostgresAdmin(process.env.CHAT_SEARCH_TEST_ADMIN_URL);
const require=createRequire(path.join(root,'services/catalog-service/package.json'));
require('reflect-metadata');require('ts-node').register({transpileOnly:true,project:path.join(root,'services/catalog-service/tsconfig.json')});
const {Pool}=require('pg'),load=file=>require(path.join(root,'services/catalog-service/src',file));
const {CATALOG_MIGRATIONS}=load('database/catalog-migrations.ts'),{migrateCatalog}=load('database/migrations.ts');
const {CATALOG_SCHEMA_FACTS_SQL}=load('database/schema-catalog.ts'),{CHAT_SEARCH_SCHEMA_SQL}=load('chat-search/chat-search.schema.ts');
const admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000,statement_timeout:30000});
const database='nc_chat_search_measure_'+randomUUID().replaceAll('-','');
const receipt={port:Number(url.port),mainPostgresContacted:false,historicalFactsPreserved:false,databaseDropped:false};let pool,created=false;
try{
    const version=(await admin.query('SHOW server_version_num')).rows[0].server_version_num;
    assert.equal(Math.floor(Number(version)/10000),16,'Physical schema facts require PostgreSQL16.');
    await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
    pool=new Pool({connectionString:url.href,max:1,statement_timeout:30000});
    await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(row=>row.version<39));
    const before=(await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows;
    await pool.query(CHAT_SEARCH_SCHEMA_SQL);
    const after=(await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows,keys=new Set(before.map(row=>row.kind+':'+row.id));
    for(const row of before)assert.deepEqual(after.find(value=>value.kind===row.kind&&value.id===row.id),row);
    const contract=after.filter(row=>!keys.has(row.kind+':'+row.id)).sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
    assert.ok(contract.length>40,'All table/column/constraint/index/trigger facts must be measured.');
    assert.ok(contract.every(row=>row.id.startsWith('chat_search_')||row.id==='neurocenter_chat_search_revision()'||row.id==='project_chat_messages.chat_search_revision'));
    const write=process.argv.includes('--write-contract');
    if(write)await writeFile(path.join(root,'services/catalog-service/src/chat-search/chat-search.schema-contract.ts'),
        '/** Migration39 physical facts measured on owned PostgreSQL16. */\nexport const CHAT_SEARCH_SCHEMA_CONTRACT = '+JSON.stringify(contract,null,2)+';\n');
    Object.assign(receipt,{postgresVersion:version,historicalFactsPreserved:true,facts:contract.length,wroteContract:write});
}finally{
    await pool?.end();
    if(created){await admin.query('DROP DATABASE '+database);receipt.databaseDropped=true;}
    await admin.end();
    const output=path.join(root,'.run/chat-search-verification');await mkdir(output,{recursive:true});
    await writeFile(path.join(output,'schema-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify(receipt));
}
