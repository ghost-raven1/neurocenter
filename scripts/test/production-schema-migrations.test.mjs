import {test} from 'node:test';
import assert from 'node:assert/strict';
import {schemaServices,validateSchemaManifest,inspectSchemaManifests,runSchemaCommands} from '../production/schema-migrations.mjs';

const entry={version:1,name:'fixture-schema',checksum:'a'.repeat(64)};
const manifests={
    'catalog-service':[{...entry,version:0},{...entry,name:'fixture-installed'}],
    'feature-flags-service':[entry],
    'rag-sync-service':[{...entry,scope:'data',version:'project-generations-1'},{...entry,scope:'base',version:'database-lifecycle-1'},{...entry,scope:'project',version:'project-identity-1'}],
};
const images=Object.fromEntries(schemaServices.map((service,index)=>[service,'sha256:'+String(index+1).repeat(64)]));

test('Опись схем проверяет checksum, номера и уникальную идентичность записи',()=>{
    for(const service of schemaServices)assert.equal(validateSchemaManifest(service,manifests[service]),manifests[service]);
    for(const value of [null,[],[entry,entry],[entry,{...entry,name:'different'}],[{...entry,version:-1}],[{...entry,name:' '}],[{...entry,checksum:'changed'}],[{...entry,checksum:[entry.checksum]}],[{...entry,sql:'private'}]]){
        assert.throws(()=>validateSchemaManifest('feature-flags-service',value),/опись миграций/);
    }
    assert.throws(()=>validateSchemaManifest('rag-sync-service',[entry]),/опись миграций/);
    assert.throws(()=>validateSchemaManifest('catalog-service',[{...entry,scope:'base'}]),/опись миграций/);
});

test('Manifest запускается без сети из каждого точного образа, а не из release tag',async()=>{
    const calls=[];
    const values=await inspectSchemaManifests(images,async args=>{
        calls.push(args);const service=schemaServices.find(name=>args.includes(images[name]));return JSON.stringify(manifests[service]);
    });
    assert.deepEqual(values,manifests);assert.equal(calls.length,3);
    for(const args of calls){
        assert.deepEqual(args.slice(0,5),['run','--rm','--network','none','--read-only']);
        assert.ok(args.includes('--cap-drop'));assert.ok(args.includes('ALL'));
        assert.deepEqual(args.slice(-2),['/app/dist/database/migrate.cli.js','manifest']);
    }
});

test('Повреждённый JSON или пустая опись образа не подтверждают его миграции',async()=>{
    for(const output of ['not-json','[]','{"ok":true}'])await assert.rejects(inspectSchemaManifests(images,async()=>output),/опись миграций/);
});

test('Check разрешает известные pending-миграции и не запускает серверы',async()=>{
    const calls=[];
    const result=await runSchemaCommands({run:async(args,options)=>{
        calls.push({args,options});return JSON.stringify({ok:true,ready:false,existingSchema:false,applied:[],pending:[0]});
    }},'check');
    assert.deepEqual(Object.keys(result),schemaServices);
    assert.deepEqual(calls.map(call=>call.args.at(-3)),schemaServices);
    for(const {args} of calls){
        assert.deepEqual(args.slice(0,5),['run','--rm','--no-deps','-T','--read-only']);
        assert.deepEqual(args.slice(-2),['dist/database/migrate.cli.js','check']);
        assert.ok(args.includes('--pull'));assert.ok(args.includes('never'));
    }
});

test('Migrate применяет каталог, флаги и RAG последовательно в оставшийся бюджет паузы',async()=>{
    let budget=9000;const calls=[];
    await runSchemaCommands({run:async(args,options)=>{
        calls.push({service:args.at(-3),options});budget-=1000;return JSON.stringify({ok:true,ready:true,existingSchema:true,applied:[1],pending:[]});
    }},'migrate',{remainingMs:()=>budget});
    assert.deepEqual(calls,schemaServices.map((service,index)=>({service,options:{timeout:9000-index*1000}})));
});

for(const output of ['', 'not-json', '{"ok":false,"ready":true,"existingSchema":true,"applied":[1],"pending":[]}', '{"ok":true,"ready":false,"existingSchema":true,"applied":[1],"pending":[]}', '{"ok":true,"ready":true,"existingSchema":true,"applied":[1],"pending":[1]}', '{"ok":true,"ready":true,"existingSchema":false,"applied":[1],"pending":[]}', '{"ok":true,"ready":true,"existingSchema":true,"applied":[],"pending":[]}']){
    test('Migrate не принимает неподтверждённую готовность: '+JSON.stringify(output),async()=>{
        let calls=0;await assert.rejects(runSchemaCommands({run:async()=>{calls++;return output;}},'migrate'),/готовность схемы/);assert.equal(calls,1);
    });
}

test('Отказ одной схемы не запускает последующие команды',async()=>{
    const calls=[];
    await assert.rejects(runSchemaCommands({run:async args=>{
        calls.push(args.at(-3));if(calls.length===2)throw Error('fixture migration failed');return JSON.stringify({ok:true,ready:true,existingSchema:true,applied:[1],pending:[]});
    }},'migrate'),/fixture migration failed/);
    assert.deepEqual(calls,['catalog-service','feature-flags-service']);
});
test('Отсутствующие applied или presence не выдаются за новую пустую схему',async()=>{
    for(const receipt of [{ok:true,ready:false,existingSchema:false,pending:[0]},{ok:true,ready:false,applied:[],pending:[0]}]){
        await assert.rejects(runSchemaCommands({run:async()=>JSON.stringify(receipt)},'check'),/готовность схемы/);
    }
});
test('Неизвестный presence RAG не разрешается даже при подтверждённо пустом каталоге',async()=>{
    await assert.rejects(runSchemaCommands({run:async args=>JSON.stringify({ok:true,ready:false,applied:[],pending:[1],
        ...(args.at(-3)==='rag-sync-service'?{}:{existingSchema:false})})},'check'),/готовность схемы rag-sync-service/);
});
