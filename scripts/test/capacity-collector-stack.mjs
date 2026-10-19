import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {docker,repositoryRoot} from '../production/compose-client.mjs';
const image='node:24.22.0-bookworm-slim';
const prefix='nc-capacity-'+randomUUID().slice(0,8);
const resources=['postgres','skills','projects','backups','runtime-artifacts'];
const volumes=Object.fromEntries([...resources,'capacity'].map(key=>[key,prefix+'-'+key]));
const collector=prefix+'-collector';const checks=[];
const shared=['--mount',`type=bind,source=${path.join(repositoryRoot,'services/shared')},target=/shared,readonly`];
const clientArgs=['run','--rm','--network','none','--read-only',...shared,'--mount',`type=volume,source=${volumes.capacity},target=/capacity,readonly`,'--mount',`type=volume,source=${volumes.skills},target=/app/skills`,'-e','CAPACITY_REQUIRED=true',image,'node','-e'];
const client=async bytes=>JSON.parse(await docker([...clientArgs,`const fs=require('fs');const {reserveCapacity}=require('/shared/capacity.cjs');(async()=>{let started=false;try{const release=await reserveCapacity({resource:'skills',bytes:${bytes},path:'/app/skills'});try{started=true;}finally{release();}console.log(JSON.stringify({ok:true,started}));}catch(error){console.log(JSON.stringify({ok:false,started,code:error.code,status:error.statusCode}));}})();`]));
const editSnapshot=async expression=>docker(['run','--rm','--network','none','--read-only','--mount',`type=volume,source=${volumes.capacity},target=/capacity`,image,'node','-e',`const fs=require('fs');const f='/capacity/snapshot.json';const s=JSON.parse(fs.readFileSync(f));${expression};fs.writeFileSync(f,JSON.stringify(s));`]);
try{
    for(const volume of Object.values(volumes)){await docker(['volume','create',volume]);}
    await docker(['run','--rm','--network','none','--mount',`type=volume,source=${volumes.postgres},target=/pg`,image,'node','-e',"const fs=require('fs');fs.mkdirSync('/pg/pg_wal');fs.writeFileSync('/pg/pg_wal/000000010000000000000001','wal');fs.chmodSync('/pg',0o700);fs.chownSync('/pg',999,999);"]);
    await docker(['run','-d','--name',collector,'--network','none','--read-only','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges',...shared,...resources.flatMap(key=>['--mount',`type=volume,source=${volumes[key]},target=/volumes/${key},readonly`]),'--mount',`type=volume,source=${volumes.capacity},target=/capacity`,image,'node','/shared/capacity-collector.cjs']);
    let snapshot;
    for(let attempt=0;attempt<20;attempt++){
        try{await docker(['exec',collector,'node','/shared/capacity-collector.cjs','--check']);snapshot=JSON.parse(await docker(['exec',collector,'node','-e',"console.log(require('fs').readFileSync('/capacity/snapshot.json','utf8'))"]));break;}
        catch{await new Promise(resolve=>setTimeout(resolve,200));}
    }
    assert.ok(snapshot);assert.equal(snapshot.resources.wal.walBytes,3);assert.ok(snapshot.resources.postgres.freeBytes>0);checks.push('Реальные read-only тома и WAL доступны сборщику без сети и сокета Docker');
    await docker(['exec',collector,'node','-e',"require('fs').writeFile('/volumes/projects/forbidden','x',error=>{if(error?.code!=='EROFS')process.exit(1);})"]);checks.push('Попытка записи в исходный том отклонена файловой системой');
    assert.deepEqual(await client(1),{ok:true,started:true});checks.push('Приложение читает свежий snapshot через read-only директорийный mount');
    await docker(['stop','--time','5',collector]);
    await editSnapshot('s.observedAt=Date.now();for(const item of Object.values(s.resources)){item.freeBytes=1073741825;}');
    assert.deepEqual(await client(2),{ok:false,started:false,code:'CAPACITY_LOW',status:507});checks.push('Недостаток физического места даёт 507 до начала записи');
    await editSnapshot('s.observedAt=Date.now()-90001;');
    assert.deepEqual(await client(1),{ok:false,started:false,code:'CAPACITY_UNAVAILABLE',status:503});checks.push('Просроченный замер даёт 503 до начала записи');
    const directory=path.join(repositoryRoot,'.run/capacity-p0');await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'collector-smoke.json'),JSON.stringify({at:new Date().toISOString(),checks,checksPassed:checks.length,snapshot,scope:'disposable Docker volumes; source-mounted collector; no production images rebuilt'},null,2)+'\n');
    console.log(JSON.stringify({checks:checks.length,passed:checks}));
}finally{
    await docker(['rm','--force',collector]).catch(()=>undefined);
    for(const volume of Object.values(volumes)){await docker(['volume','rm',volume]);}
}
