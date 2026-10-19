import assert from 'node:assert/strict';

/** Все настройки и отказы относятся только к отдельному fixture Compose-проекту. */
export async function verifyProductionMaintenance({check,request,query}){
    let status;
    await check('Production API отдаёт политику, RPO и реальные физические тома главному администратору',async()=>{
        const policy=await request('/api/maintenance/policy');assert.equal(policy.status,200,JSON.stringify(policy.data));status=policy.data;
        assert.equal(status.revision,0);assert.equal(status.policy.enabled,false);assert.equal(status.external,null);assert.equal(status.externalAgeSeconds,null);assert.equal(status.rpoExceeded,true);
        const capacity=await request('/api/maintenance/capacity');assert.equal(capacity.status,200);assert.equal(capacity.data.available,true,JSON.stringify(capacity.data));
        assert.ok(Date.now()-Date.parse(capacity.data.observedAt)<90000);assert.equal(capacity.data.reserveBytes,1073741824);
        assert.deepEqual(Object.keys(capacity.data.resources).sort(),['postgres','wal','skills','projects','backups','runtime-artifacts'].sort());
        for(const item of Object.values(capacity.data.resources)){assert.equal(item.available,true);assert.ok(item.totalBytes>0);assert.ok(item.freeBytes>0&&item.freeBytes<=item.totalBytes);}
        assert.ok(capacity.data.resources.wal.walBytes>0);
    });
    await check('Расписание, IANA-зона, окна, пауза, retention и RPO/RTO сохраняются с доверенным аудитом',async()=>{
        const policy={...status.policy,enabled:true,timeZone:'Asia/Tomsk',maxPauseMinutes:20,localCopies:3,externalRetentionDays:21,rpoMinutes:360,rtoMinutes:120};
        const saved=await request('/api/maintenance/policy',{method:'PATCH',headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'forged@example.test',activeRole:'Главный админ'}))},body:{expectedRevision:status.revision,policy}});
        assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.revision,1);assert.deepEqual(saved.data.policy,policy);
        status=(await request('/api/maintenance/policy')).data;assert.equal(status.revision,1);assert.ok(status.nextRunAt&&Date.parse(status.nextRunAt)>Date.now());
        const event=JSON.parse(query('catalog',"SELECT json_build_object('actor',actor,'before',before_state,'after',after_state) FROM security_events WHERE action='maintenance.policy.update' ORDER BY created_at DESC LIMIT 1"));
        assert.equal(event.actor,'admin@example.test');assert.equal(event.before.revision,0);assert.equal(event.after.revision,1);assert.deepEqual(event.after.policy,policy);
    });
    await check('Два сохранения политики с одной ревизией дают один успех и один 409 без лишнего аудита',async()=>{
        const replies=await Promise.all([7,8].map(localCopies=>request('/api/maintenance/policy',{method:'PATCH',body:{expectedRevision:status.revision,policy:{...status.policy,localCopies}}})));
        assert.deepEqual(replies.map(item=>item.status).sort(),[200,409]);status=(await request('/api/maintenance/policy')).data;assert.equal(status.revision,2);
        assert.equal(query('catalog',"SELECT count(*) FROM security_events WHERE action='maintenance.policy.update'"),'2');
        const stale=await request('/api/maintenance/policy',{method:'PATCH',body:{expectedRevision:1,policy:{...status.policy,localCopies:9}}});assert.equal(stale.status,409);
        const invalid=await request('/api/maintenance/policy',{method:'PATCH',body:{expectedRevision:2,policy:{...status.policy,timeZone:'not-a-time-zone'}}});assert.equal(invalid.status,400);
        assert.equal((await request('/api/maintenance/policy')).data.revision,2);assert.equal(query('catalog',"SELECT count(*) FROM security_events WHERE action='maintenance.policy.update'"),'2');
    });
}

export async function verifyProductionMaintenancePermissions({check,request}){
    await check('Наблюдатель, разработчик и админ проекта не читают и не меняют политику или физические ресурсы',async()=>{
        const before=(await request('/api/maintenance/policy')).data;
        try{
            for(const role of ['Наблюдатель','Разработчик','Админ проекта']){
                assert.equal((await request('/auth/switch-role',{method:'POST',body:{role}})).status,200);
                assert.equal((await request('/api/maintenance/policy')).status,403);assert.equal((await request('/api/maintenance/capacity')).status,403);
                assert.equal((await request('/api/maintenance/policy',{method:'PATCH',body:{expectedRevision:before.revision,policy:before.policy}})).status,403);
            }
        }finally{assert.equal((await request('/auth/switch-role',{method:'POST',body:{role:'Главный админ'}})).status,200);}
        assert.deepEqual((await request('/api/maintenance/policy')).data.policy,before.policy);
    });
}

/** Подмена только производного snapshot собственного fixture; реальные диски не заполняются. */
export async function verifyProductionCapacityAdmission({check,request,docker,projectId}){
    const manifest=()=>request('/api/rag/manifest?projectKey='+projectId);
    const delta={projectKey:projectId,chunks:[{id:'capacity-fixture',filePath:'capacity.md',content:'Повтор после восстановления места',embedding:null}]};
    const mutate=expression=>docker(['run','--rm','--no-deps','--entrypoint','node','capacity-collector','-e',"const fs=require('fs');const f='/capacity/snapshot.json';const s=JSON.parse(fs.readFileSync(f));"+expression+"fs.writeFileSync(f,JSON.stringify(s));"]);
    const before=(await manifest()).data;
    await check('Нехватка физического места даёт HTTP 507 до изменения знаний и видна в capacity API',async()=>{
        docker(['stop','capacity-collector']);
        try{
            mutate('s.observedAt=Date.now();for(const item of Object.values(s.resources)){item.freeBytes=1073741825;}');
            const state=await request('/api/maintenance/capacity');assert.equal(state.data.available,true);assert.equal(state.data.resources.postgres.freeBytes,1073741825);
            const failed=await request('/api/rag/sync',{method:'POST',body:delta});assert.equal(failed.status,507,JSON.stringify(failed.data));assert.match(failed.data.message,/Недостаточно/);assert.deepEqual((await manifest()).data,before);
        }finally{docker(['start','--wait','capacity-collector']);}
    });
    await check('Просроченный замер даёт HTTP 503, после свежего замера повтор не дублирует знания',async()=>{
        docker(['stop','capacity-collector']);
        try{
            mutate('s.observedAt=Date.now()-90001;');
            assert.equal((await request('/api/maintenance/capacity')).data.available,false);
            const failed=await request('/api/rag/sync',{method:'POST',body:delta});assert.equal(failed.status,503,JSON.stringify(failed.data));assert.deepEqual((await manifest()).data,before);
        }finally{docker(['start','--wait','capacity-collector']);}
        for(let attempt=0;attempt<2;attempt++){assert.equal((await request('/api/rag/sync',{method:'POST',body:delta})).status,201);}
        assert.equal((await manifest()).data.count,before.count+1);
        assert.equal((await request('/api/rag/sync',{method:'POST',body:{projectKey:projectId,chunks:[],deletes:['capacity-fixture']}})).status,201);
        assert.deepEqual((await manifest()).data,before);
    });
}
