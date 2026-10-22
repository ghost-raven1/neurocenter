import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ownedTestPostgresAdmin} from './owned-postgres.fixture.mjs';

for(const scheme of ['postgres','postgresql'])test('accepts an explicitly owned alternate PostgreSQL port: '+scheme,()=>{
    assert.equal(ownedTestPostgresAdmin(scheme+'://qa:qa@127.0.0.1:59234/postgres').port,'59234');
});
for(const [index,value]of [undefined,'not a URL','http://127.0.0.1:59234/postgres','postgres://127.0.0.1/postgres','postgres://127.0.0.1:5432/postgres',
    'postgres://localhost:59234/postgres','postgres://example.test:59234/postgres','postgres://127.0.0.1:59234/catalog',
    'postgres://127.0.0.1:59234/postgres?application_name=foreign','postgres://127.0.0.1:59234/postgres#foreign'].entries())test('rejects an unsafe fixture URL '+index,()=>{
    assert.throws(()=>ownedTestPostgresAdmin(value),/explicitly owned/);
});

const folder=fileURLToPath(new URL('.',import.meta.url));
for(const file of ['access-database.mjs','production-bootstrap.mjs','project-profile-delete-db.mjs','project-size-db.mjs','project-retention-access-db.mjs']){
    for(const admission of ['missing','main-port'])test(file+' refuses '+admission+' before opening a network connection',()=>{
        const own=mkdtempSync(path.join(tmpdir(),'nc-access-admission-')),marker=path.join(own,'network-attempt'),hook=path.join(own,'no-network.cjs');
        writeFileSync(hook,"const fs=require('node:fs');require('node:net').Socket.prototype.connect=function(){fs.writeFileSync(process.env.ACCESS_TEST_NETWORK_MARKER,'attempt');throw Error('NETWORK_BEFORE_FIXTURE_ADMISSION');};\n");
        const env={...process.env,ACCESS_TEST_NETWORK_MARKER:marker};for(const key of ['PUBLICATION_TEST_PG_URL','TEST_ADMIN_PG_URL','CATALOG_TEST_PG_URL','CATALOG_PG_URL'])delete env[key];
        if(admission==='main-port')env.PUBLICATION_TEST_PG_URL='postgresql://qa:qa@127.0.0.1:5432/postgres';
        try{const result=spawnSync(process.execPath,['--require',hook,path.join(folder,file)],{env,cwd:own,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
            assert.equal(result.status,1);assert.match(result.stderr,/explicitly owned/);assert.equal(existsSync(marker),false);
        }finally{rmSync(own,{recursive:true,force:true});}
    });
}
