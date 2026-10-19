import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';

/** Пакет скилла проходит настоящие HTTPS, авторизацию шлюза и файловое хранилище production-образа. */
export async function verifyProductionSkills({check,request}) {
    const route='/api/skills/common/full-resource-fixture';
    const resource={path:'assets/пример.bin',content:'AP+ADQo=',encoding:'base64'};
    await check('HTTPS-публикация сохраняет ресурсы, а старая версия доступна после обновления',async()=>{
        const created=await request('/api/skills',{method:'POST',body:{path:'common',slug:'full-resource-fixture',name:'Проверка ресурсов',body:'Исходная инструкция',meta:{description:'Тестовый скилл с ресурсами'},resources:[resource]}});
        assert.equal(created.status,201,JSON.stringify(created.data));assert.deepEqual(created.data.resources,[resource]);
        const updated=await request(route,{method:'PUT',body:{expectedVersion:1,body:'Новая инструкция',resources:[]}});
        assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal(updated.data.meta.version,2);
        const previous=await request(route+'?version=1');assert.equal(previous.status,200);assert.equal(previous.data.body,'Исходная инструкция');assert.deepEqual(previous.data.resources,[resource]);
    });
    await check('HTTPS-проверка ресурсов отклоняет обход пути, неверное кодирование и конфликт версии',async()=>{
        for(const resources of [[{path:'assets/../secret',content:'x'}],[{path:'assets/a',content:'Zg',encoding:'base64'}]]){
            assert.equal((await request(route,{method:'PUT',body:{expectedVersion:2,resources}})).status,400);
        }
        assert.equal((await request(route,{method:'PUT',body:{expectedVersion:1,body:'Устаревший черновик'}})).status,409);
        assert.equal((await request(route+'?version=99')).status,404);
        assert.equal((await request(route+'?version=NaN')).status,400);
        assert.equal((await request('/api/skills/_package/common/full-resource-fixture')).status,400);
        assert.equal((await request('/api/skills/_package/common/full-resource-fixture?version=1')).data.resources[0].encoding,'base64');
        assert.equal((await request(route)).data.meta.version,2);
    });
}

/** Устройство здесь имитируется: проверяется выдача задания, файлов на компьютере не создаём. */
export async function verifyProductionSkillJobs({check,request,projectId}) {
    const token=randomBytes(32).toString('hex');let deviceId,plan;
    const channel=(route,body={})=>request('/api/device-channel/'+route,{method:'POST',body,headers:{Authorization:'Bearer '+token}});
    const bindingId='b'.repeat(64);
    const report={root:'/fixture',folders:['project'],bindings:[{projectId,folderName:'project',valid:true,bindingId}],protocolVersion:2,
        bridgeVersion:'0.5.0',capabilities:['durable-completions','managed-installations','install-set-v1','package-v3']};
    await check('Бинарный скилл не выдаётся мосту без поддержки нового формата',async()=>{
        const pair=await channel('pair/start',{name:'Проверка полного пакета',fingerprint:'b'.repeat(64),credentialHash:createHash('sha256').update(token).digest('hex')});assert.equal(pair.status,201);
        assert.equal((await request('/api/device-pairs/'+pair.data.userCode+'/approve',{method:'POST',body:{}})).status,201);
        deviceId=(await channel('pair/poll',{deviceCode:pair.data.deviceCode})).data.deviceId;assert.ok(deviceId);
        assert.equal((await channel('heartbeat',report)).status,201);
        assert.equal((await request('/api/projects/'+projectId+'/assets',{method:'POST',body:{assetKind:'skill',assetId:'common/full-resource-fixture'}})).status,201);
        const prepared=await request('/api/device-install-plans',{method:'POST',body:{projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1}});
        assert.equal(prepared.status,201,JSON.stringify(prepared.data));assert.equal(prepared.data.status,'pending');assert.equal(prepared.data.revision,0);
        const approved=await request('/api/device-install-plans/'+prepared.data.id+'/approve',{method:'POST',body:{expectedManifest:prepared.data.manifest,expectedRevision:prepared.data.revision}});
        assert.equal(approved.status,201,JSON.stringify(approved.data));plan=approved.data;
        const response=await request('/api/device-jobs',{method:'POST',body:{kind:'install',deviceId,projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1,requestKey:randomUUID(),planId:plan.id,planRevision:plan.revision}});
        assert.equal(response.status,409);assert.ok(response.data.message.includes('Обновите'));
    });
    await check('HTTPS-установка требует одобрения именно этой версии даже у главного админа',async()=>{
        assert.equal((await channel('heartbeat',{...report,capabilities:[...report.capabilities,'package-v4']})).status,201);
        const base={kind:'install',deviceId,projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1,requestKey:randomUUID()};
        assert.equal((await request('/api/device-jobs',{method:'POST',body:base})).status,409);
        assert.equal((await request('/api/device-jobs',{method:'POST',body:{...base,planId:plan.id,planRevision:plan.revision,version:2}})).status,409);
        const prepared=await request('/api/device-install-plans',{method:'POST',body:{projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:2}});
        assert.equal(prepared.status,201);assert.equal(prepared.data.status,'pending');assert.notEqual(prepared.data.manifest,plan.manifest);
        assert.equal((await request('/api/device-jobs',{method:'POST',body:{...base,version:2,planId:prepared.data.id,planRevision:0}})).status,409);
        for (const expectedManifest of [{toString:null},[],null]) {
            assert.equal((await request('/api/device-install-plans/'+prepared.data.id+'/approve',{method:'POST',body:{expectedManifest,expectedRevision:0}})).status,400);
        }
    });
    await check('Разработчик не может одобрить план через прямой HTTPS-запрос',async()=>{
        const member=await request('/api/projects/'+projectId+'/members',{method:'POST',body:{principalName:'admin@example.test',role:'Разработчик'}});assert.equal(member.status,201);
        assert.equal((await request('/auth/switch-role',{method:'POST',body:{role:'Разработчик'}})).status,200);
        try { assert.equal((await request('/api/device-install-plans/'+plan.id+'/approve',{method:'POST',body:{expectedManifest:plan.manifest,expectedRevision:plan.revision}})).status,403); }
        finally {
            assert.equal((await request('/auth/switch-role',{method:'POST',body:{role:'Главный админ'}})).status,200);
            assert.equal((await request('/api/projects/'+projectId+'/members/'+encodeURIComponent(member.data.userId),{method:'DELETE',body:{}})).status,200);
        }
    });
    await check('Каталог проекта не принимает ссылку на приватный скилл другого проекта',async()=>{
        const response=await request('/api/projects/'+projectId+'/assets',{method:'POST',body:{assetKind:'skill',assetId:'project-prj-foreign/private'}});
        assert.equal(response.status,403,JSON.stringify(response.data));assert.ok(response.data.message.includes('другого проекта'));
    });
    await check('Очередь через HTTPS закрепляет старую версию со всеми ресурсами и сверяет результат',async()=>{
        assert.equal((await channel('heartbeat',{...report,capabilities:[...report.capabilities,'package-v4']})).status,201);
        const body={kind:'install',deviceId,projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1,requestKey:randomUUID(),planId:plan.id,planRevision:plan.revision};
        const created=await request('/api/device-jobs',{method:'POST',body});assert.equal(created.status,201,JSON.stringify(created.data));
        assert.equal((await request('/api/device-jobs',{method:'POST',body})).data.id,created.data.id);
        const claimed=await channel('jobs/claim');assert.equal(claimed.status,201);assert.equal(claimed.data.id,created.data.id);
        const pkg=claimed.data.payload.package;assert.equal(pkg.schemaVersion,4);assert.equal(pkg.plugin.version,1);
        assert.ok(pkg.files.find(file=>file.path==='SKILL.md').content.includes('Исходная инструкция'));
        assert.equal(pkg.files.find(file=>file.path==='assets/пример.bin').content,'AP+ADQo=');
        assert.equal((await channel('jobs/'+created.data.id+'/authorize',{lease:claimed.data.lease})).status,201);
        assert.ok([400,409].includes((await channel('jobs/'+created.data.id+'/progress',{lease:claimed.data.lease,state:'succeeded',message:'Ложный успех без квитанции'})).status));
        const completed=await channel('jobs/'+created.data.id+'/complete',{lease:claimed.data.lease,state:'failed',message:'Проверка протокола: файлы не записывались',
            result:{projectId,assetId:pkg.plugin.id,version:1,manifest:pkg.manifest.sha256,bindingId,unchanged:true}});
        assert.equal(completed.status,201);assert.equal((await request('/api/device-jobs')).data.find(job=>job.id===created.data.id).state,'failed');
    });
    await check('Отзыв и повторное одобрение через HTTPS не оживляют ожидающий план',async()=>{
        const body={kind:'install',deviceId,projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1,requestKey:randomUUID(),planId:plan.id,planRevision:plan.revision};
        const created=await request('/api/device-jobs',{method:'POST',body});assert.equal(created.status,201);
        const revoked=await request('/api/device-install-plans/'+plan.id+'/revoke',{method:'POST',body:{expectedManifest:plan.manifest,expectedRevision:plan.revision}});
        assert.equal(revoked.status,201);assert.equal(revoked.data.status,'revoked');
        const approved=await request('/api/device-install-plans/'+plan.id+'/approve',{method:'POST',body:{expectedManifest:plan.manifest,expectedRevision:revoked.data.revision}});
        assert.equal(approved.status,201);assert.equal(approved.data.revision,3);
        const claimed=await channel('jobs/claim');assert.equal(claimed.status,201);assert.ok(!claimed.data);
        assert.equal((await request('/api/device-jobs')).data.find(job=>job.id===created.data.id).state,'failed');
        assert.equal((await request('/api/device-jobs/'+created.data.id+'/retry',{method:'POST',body:{requestKey:randomUUID()}})).status,409);
        plan=approved.data;
    });
    await check('Отзыв после выдачи задания проверяется снова до записи файлов',async()=>{
        const body={kind:'install',deviceId,projectId,assetKind:'skill',assetId:'common/full-resource-fixture',version:1,requestKey:randomUUID(),planId:plan.id,planRevision:plan.revision};
        const created=await request('/api/device-jobs',{method:'POST',body});assert.equal(created.status,201);
        const claimed=await channel('jobs/claim');assert.equal(claimed.data.id,created.data.id);
        const revoked=await request('/api/device-install-plans/'+plan.id+'/revoke',{method:'POST',body:{expectedManifest:plan.manifest,expectedRevision:plan.revision}});assert.equal(revoked.status,201);
        assert.equal((await channel('jobs/'+created.data.id+'/authorize',{lease:claimed.data.lease})).status,409);
        const pkg=claimed.data.payload.package;
        const done=await channel('jobs/'+created.data.id+'/complete',{lease:claimed.data.lease,state:'failed',message:'Отзыв до записи',result:{projectId,assetId:pkg.plugin.id,version:1,manifest:pkg.manifest.sha256,bindingId,unchanged:true}});
        assert.equal(done.status,201);
    });
}
