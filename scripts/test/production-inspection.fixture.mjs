import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** HTTPS/SSO/PG проверяют протокол; подставное устройство не читает и не пишет локальные файлы. */
export async function verifyProductionInspection({check,request,query,projectId}) {
    const token=randomBytes(32).toString('hex');
    const post=(route,body)=>request(route,{method:'POST',body});
    const channel=(route,body={})=>request('/api/device-channel/'+route,{method:'POST',body,headers:{Authorization:'Bearer '+token}});
    const A='a'.repeat(64),B='b'.repeat(64);
    const report=bindingId=>({root:'/fixture',folders:['A','B'],bindings:[{projectId,folderName:bindingId===A?'A':'B',bindingId,valid:true}],
        protocolVersion:2,bridgeVersion:'0.6.0',capabilities:['durable-completions','managed-installations','package-v3','package-v4','install-set-v1','installation-inspection-v1']});
    let deviceId,assetId,pkg,plan1,plan2,claimed,observerMember;
    const install=async(plan,bindingId)=>{
        const queued=await post('/api/device-jobs',{deviceId,projectId,kind:'install',assetId,assetKind:'mcp',version:plan.version,
            planId:plan.id,planRevision:plan.revision,expectedBindingId:bindingId,requestKey:randomUUID()});
        assert.equal(queued.status,201,JSON.stringify(queued.data));const job=(await channel('jobs/claim')).data;
        assert.equal(job.id,queued.data.id);assert.equal((await channel('jobs/'+job.id+'/authorize',{lease:job.lease})).status,201);
        const done=await channel('jobs/'+job.id+'/complete',{lease:job.lease,state:'succeeded',message:'Подставное устройство: проверка протокола',
            result:{projectId,bindingId,assetId,version:plan.version,manifest:job.payload.package.manifest.sha256,readiness:'unverified'}});
        assert.equal(done.status,201,JSON.stringify(done.data));
    };
    const prepare=async version=>{
        const pending=await post('/api/device-install-plans',{projectId,assetId,assetKind:'mcp',version});assert.equal(pending.status,201,JSON.stringify(pending.data));
        const approved=await post('/api/device-install-plans/'+pending.data.id+'/approve',{expectedManifest:pending.data.manifest,expectedRevision:pending.data.revision});
        assert.equal(approved.status,201);return approved.data;
    };
    const target=(kind,bindingId=B)=>({deviceId,projectId,kind,assetKind:'mcp',assetId,expectedManifest:pkg.manifest.sha256,expectedBindingId:bindingId,requestKey:randomUUID()});
    await check('HTTPS-история сохраняет отдельные версии одного инструмента в папках A и B',async()=>{
        const created=await post('/api/ai-plugins',{name:'Проверка истории папок',kind:'mcp',description:'Подставные установки для проверки API',
            config:{transport:'remote',url:'https://example.test/inspection-v1'},publicationKey:randomUUID()});assert.equal(created.status,201,JSON.stringify(created.data));assetId=created.data.id;
        assert.equal((await post('/api/projects/'+projectId+'/assets',{assetKind:'mcp',assetId})).status,201);
        pkg=(await request('/api/ai-plugins/'+assetId+'/package?version=1')).data;plan1=await prepare(1);
        const pair=await channel('pair/start',{name:'Подставной компьютер сверки',fingerprint:'e'.repeat(64),credentialHash:createHash('sha256').update(token).digest('hex')});
        assert.equal(pair.status,201);assert.equal((await post('/api/device-pairs/'+pair.data.userCode+'/approve',{})).status,201);
        deviceId=(await channel('pair/poll',{deviceCode:pair.data.deviceCode})).data.deviceId;
        assert.equal((await channel('heartbeat',report(A))).status,201);await install(plan1,A);
        assert.equal((await request('/api/ai-plugins/'+assetId,{method:'PATCH',body:{expectedVersion:1,config:{transport:'remote',url:'https://example.test/inspection-v2'}}})).status,200);
        plan2=await prepare(2);assert.equal((await channel('heartbeat',report(B))).status,201);await install(plan2,B);
        const rows=(await request('/api/device-installations')).data.filter(item=>item.deviceId===deviceId&&item.assetId===assetId);
        assert.equal(rows.length,2);assert.equal(rows.find(item=>item.bindingId===A).version,1);assert.equal(rows.find(item=>item.bindingId===B).version,2);
        assert.equal(rows.find(item=>item.bindingId===B).isCurrentBinding,true);assert.equal(rows.find(item=>item.bindingId===A).bindingChanged,true);
    });
    await check('Одинаковый SHA в двух папках не обходит expectedBindingId; удаление A сохраняет B',async()=>{
        await install(plan1,B);
        assert.equal((await post('/api/device-jobs',target('uninstall',A))).status,409);
        assert.equal((await channel('heartbeat',report(A))).status,201);
        const queued=await post('/api/device-jobs',target('uninstall',A));assert.equal(queued.status,201,JSON.stringify(queued.data));
        const job=(await channel('jobs/claim')).data;assert.equal(job.id,queued.data.id);
        assert.equal((await channel('jobs/'+job.id+'/authorize',{lease:job.lease})).status,201);
        assert.equal((await channel('jobs/'+job.id+'/complete',{lease:job.lease,state:'succeeded',message:'Подставное удаление',
            result:{projectId,bindingId:A,assetId,version:1,manifest:pkg.manifest.sha256}})).status,201);
        const rows=(await request('/api/device-installations')).data.filter(item=>item.deviceId===deviceId&&item.assetId===assetId);
        assert.equal(rows.length,1);assert.equal(rows[0].bindingId,B);
        assert.equal((await channel('heartbeat',report(B))).status,201);
    });
    await check('Наблюдатель проверяет установку через HTTPS, но не получает право удаления',async()=>{
        const member=await post('/api/projects/'+projectId+'/members',{principalName:'admin@example.test',role:'Наблюдатель'});assert.equal(member.status,201);observerMember=member.data;
        assert.equal((await post('/auth/switch-role',{role:'Наблюдатель'})).status,200);
        try {
            assert.equal((await post('/api/device-jobs',target('uninstall'))).status,403);
            const old=report(B);old.capabilities=old.capabilities.filter(value=>value!=='installation-inspection-v1');
            assert.equal((await channel('heartbeat',old)).status,201);
            assert.equal((await post('/api/device-jobs',target('inspect-installation'))).status,409);
            assert.equal((await channel('heartbeat',report(B))).status,201);
            const queued=await post('/api/device-jobs',target('inspect-installation'));assert.equal(queued.status,201,JSON.stringify(queued.data));
            claimed=(await channel('jobs/claim')).data;assert.equal(claimed.id,queued.data.id);
            assert.equal((await channel('jobs/'+claimed.id+'/authorize',{lease:claimed.lease})).status,201);
        } finally {assert.equal((await post('/auth/switch-role',{role:'Главный админ'})).status,200);}
    });
    await check('Сверка через HTTPS проверяет исходный контекст и сохраняется дольше последних 100 операций',async()=>{
        const result={schemaVersion:1,projectId,bindingId:B,assetId,assetKind:'mcp',version:1,manifest:pkg.manifest.sha256,checkedAt:new Date().toISOString(),
            readiness:'unverified',state:'checked',status:'synced',issues:[]};
        const body={lease:claimed.lease,state:'succeeded',message:'/Users/private/секрет не сохраняется',result};
        for(const changed of [{...result,readiness:'ready'},{...result,bindingId:A},{...result,config:{token:'секрет'}}]){
            assert.equal((await channel('jobs/'+claimed.id+'/complete',{...body,result:changed})).status,409);
        }
        assert.equal((await channel('jobs/'+claimed.id+'/progress',{...body,state:'failed',result:{config:{token:'секрет'},readiness:'ready'}})).status,409);
        assert.equal(query('catalog',`SELECT state FROM bridge_jobs WHERE id='${claimed.id}'`),'running');
        assert.equal((await channel('jobs/'+claimed.id+'/progress',{...body,state:'running',result:{config:{token:'секрет'}}})).status,400);
        assert.equal((await channel('jobs/'+claimed.id+'/progress',{lease:claimed.lease,state:'running',message:'/Users/private/секрет не сохраняется'})).status,201);
        assert.equal(query('catalog',`SELECT message FROM bridge_jobs WHERE id='${claimed.id}'`),'Проверка файлов выполняется.');
        query('catalog',`UPDATE bridge_jobs SET lease_until=now()-interval '1 second' WHERE id='${claimed.id}'`);
        assert.equal((await channel('jobs/'+claimed.id+'/complete',body)).status,201);
        assert.equal((await channel('jobs/'+claimed.id+'/complete',body)).data.repeated,true);
        const message=query('catalog',`SELECT message FROM bridge_jobs WHERE id='${claimed.id}'`);assert.equal(message.includes('/Users'),false);assert.equal(message.includes('секрет'),false);
        query('catalog',`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state,created_at,updated_at)
            SELECT 'inspection-history-'||n,'${deviceId}','admin@example.test','Главный админ','${projectId}','choose-root','{}',
                'inspection-history-'||n,'fixture','succeeded',now()+interval '1 second',now()+interval '1 second' FROM generate_series(1,130) n`);
        assert.equal((await request('/api/device-jobs')).data.some(item=>item.id===claimed.id),false);
        const rows=(await request('/api/device-installations')).data.filter(item=>item.deviceId===deviceId&&item.assetId===assetId);
        assert.equal(rows[0].inspection.status,'synced');assert.equal(rows[0].inspection.readiness,'unverified');
        assert.equal((await request('/api/projects/'+projectId+'/members/'+encodeURIComponent(observerMember.userId),{method:'DELETE',body:{}})).status,200);
    });
    await check('Legacy-история видна отдельно, но не даёт автоматической цели проверки или удаления',async()=>{
        const payload=JSON.stringify({assetId,assetKind:'mcp',version:1,package:pkg}).replaceAll("'","''");
        query('catalog',`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,state)
            VALUES('inspection-legacy','${deviceId}','admin@example.test','Главный админ','${projectId}','install','${payload}'::jsonb,'inspection-legacy','fixture','succeeded')`);
        const legacy=(await request('/api/device-installations')).data.find(item=>item.deviceId===deviceId&&item.assetId===assetId&&item.legacyBinding);
        assert.ok(legacy);assert.equal(legacy.bindingChanged,true);assert.equal(legacy.isCurrentBinding,false);assert.equal(legacy.inspection,undefined);
        for(const kind of ['inspect-installation','uninstall']){const input=target(kind);delete input.expectedBindingId;assert.equal((await post('/api/device-jobs',input)).status,409);}
    });
}
