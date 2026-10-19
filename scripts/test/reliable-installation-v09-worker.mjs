import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const repository=fileURLToPath(new URL('../../',import.meta.url));
process.env.RELIABLE_INSTALLATION_EVIDENCE_DIR ||= path.join(repository,'.run/reliable-installation-v09-20261018');
const {actor,projectId,assetId,childAssetId,evidence,createWorkerFixture,snapshot}=await import('./reliable-installation-v09-worker.fixture.mjs');
const results=[];let fixture,fatal,cleanup;const secret='ЛОКАЛЬНЫЙ_СЕКРЕТ_V09_'+randomUUID();
const check=async(name,fn)=>{try{await fn();results.push({case:name,ok:true});console.log(name);}catch(error){results.push({case:name,ok:false,error:error.message});throw error;}};
try{
    fixture=await createWorkerFixture();const f=fixture;let approval,initialStatus,readyStatus;
    const cfg=(kind,extra={})=>f.create(kind,{assetId:childAssetId,expectedManifest:f.childPkg.manifest.sha256,...extra});
    const status=async()=> (await f.run(await cfg('get-mcp-configuration-status'))).result;
    const transport=async(route,{method='POST',body={},headers={}}={})=>{
        const response=await fetch(f.origin+'/api/device-channel/'+route,{method,headers:{authorization:'Bearer '+f.token,...(method==='POST'?{'content-type':'application/json'}:{}),...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});return response;
    };
    const form=async({lostAck=false}={})=>{
        const preparationJob=await cfg('prepare-mcp-configuration');const preparation=(await f.run(preparationJob)).result;
        const openedJob=await cfg('open-mcp-configuration',{configurationPreparationJobId:preparationJob.id,expectedConfigurationSchemaDigest:preparation.schemaDigest});
        if(lostAck)f.lostAcks.add(openedJob.id);await f.run(openedJob);
        const invocations=await f.openerInvocations();const entry=invocations.filter(item=>item.configurationUrl).at(-1);assert.ok(entry);const url=new URL(entry.configurationUrl);
        const call=async(route,body,headers={})=>{const response=await fetch(url.origin+route,{method:'POST',headers:{origin:url.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});return {response,data:await response.json()};};
        const session=await call('/session',{token:url.hash.slice(1)});assert.equal(session.response.status,200);assert.ok(session.data.csrf);
        return {url,preparation,preparationJob,openedJob,session:session.data,call,save:(updates,options={})=>call('/save',{updates,remove:options.remove??[],expectedRevision:options.expectedRevision??session.data.revision},{'x-configuration-csrf':session.data.csrf,...options.headers})};
    };
    const noSecrets=async()=>{
        const tables=['bridge_jobs','device_install_plans','bridge_local_change_plans','bridge_runtime_artifacts','operations'];
        for(const table of tables){const value=JSON.stringify((await f.devices.pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t')).rows);assert.ok(!value.includes(secret),'Секрет не должен попасть в '+table);assert.ok(!value.includes('configurationUrl'),'Loopback URL не должен попасть в '+table);}
        const files=await snapshot(f.folderA);for(const name of Object.keys(files)){const bytes=await fs.readFile(path.join(f.folderA,name));assert.ok(!bytes.toString().includes(secret),'Секрет не должен попасть в проект');}
        const log=await fs.readFile(path.join(evidence,'worker.log'),'utf8');assert.ok(!log.includes(secret));
    };
    await check('Отдельный PostgreSQL и реальный source worker связывают только собственную папку',async()=>{await f.run(await f.initialBind(projectId,f.folderA));await f.heartbeat();approval=await f.approved(projectId);assert.equal(approval.packages.length,2);assert.equal(f.pkg.schemaVersion,5);assert.equal(f.childPkg.schemaVersion,5);});
    await check('HTTP выдаёт архив только для действующего lease, SHA и свежего одобрения точного графа',async()=>{
        await f.stopWorker();const installJob=await f.create('install',{version:1,planId:approval.id,planRevision:approval.revision,expectedManifest:approval.manifest});const device=await f.devices.identity(f.token);const claimed=await f.jobs.claim(device);assert.equal(claimed.id,installJob.id);
        const route=`jobs/${claimed.id}/runtime/${f.archive.descriptor.sha256}`;
        for(const [target,lease] of [[route,randomUUID()],[`jobs/${randomUUID()}/runtime/${f.archive.descriptor.sha256}`,claimed.lease],[`jobs/${claimed.id}/runtime/${'0'.repeat(64)}`,claimed.lease]]){const rejected=await transport(target,{method:'GET',headers:{'x-neurocenter-job-lease':lease}});assert.ok(rejected.status>=400);await rejected.body?.cancel();}
        const good=await transport(route,{method:'GET',headers:{'x-neurocenter-job-lease':claimed.lease}});assert.equal(good.status,200);assert.equal(good.headers.get('content-length'),String(f.archive.archive.length));assert.deepEqual(Buffer.from(await good.arrayBuffer()),f.archive.archive);
        await f.devices.pool.query("UPDATE device_install_plans SET status='revoked' WHERE id=$1",[approval.id]);const revoked=await transport(route,{method:'GET',headers:{'x-neurocenter-job-lease':claimed.lease}});assert.ok(revoked.status>=400);await revoked.body?.cancel();await f.devices.pool.query("UPDATE device_install_plans SET status='approved' WHERE id=$1",[approval.id]);
        // Собственная fixture возвращает вручную проверенный lease в очередь для настоящего worker.
        await f.devices.pool.query("UPDATE bridge_jobs SET state='queued',lease=NULL,lease_until=NULL WHERE id=$1",[claimed.id]);await f.run(installJob);
    });
    await check('Устанавливается замороженный граф v5 с общим архивом и разными точками входа без запуска',async()=>{
        const rows=(await f.installations.list(actor)).filter(item=>item.projectId===projectId);assert.equal(rows.length,2);assert.ok(rows.every(item=>item.version===1));assert.ok(!await fs.stat(f.runtimeLog).then(()=>true,()=>false));
        const rootReceipt=JSON.parse(await fs.readFile(path.join(f.folderA,f.receipts.receiptPath(f.pkg)),'utf8'));const childReceipt=JSON.parse(await fs.readFile(path.join(f.folderA,f.receipts.receiptPath(f.childPkg)),'utf8'));
        assert.ok(rootReceipt.config.value.command.some(value=>String(value).endsWith('runtime/root.mjs')));assert.ok(childReceipt.config.value.command.some(value=>String(value).endsWith('launcher-cli.js')));assert.deepEqual(rootReceipt.files,{});assert.deepEqual(childReceipt.files,{});
    });
    await check('Статус дочернего MCP сообщает обязательное поле без чтения секрета на сервер',async()=>{initialStatus=await status();assert.equal(initialStatus.ready,false);assert.deepEqual(initialStatus.missingFieldIds,['token']);assert.equal(initialStatus.revision,null);});
    await check('Loopback-мастер освобождает очередь, защищает Origin и bootstrap и сохраняет локально',async()=>{
        const opened=await form();const html=await fetch(opened.url.origin+'/');assert.equal(html.status,200);assert.ok(html.headers.get('content-security-policy').includes("default-src 'none'"));assert.ok(!html.headers.get('access-control-allow-origin'));assert.ok(!(await html.text()).includes(secret));
        assert.equal((await opened.call('/session',{token:opened.url.hash.slice(1)})).response.status,400+3);
        const foreign=await opened.save({token:secret},{headers:{origin:'https://foreign.invalid'}});assert.equal(foreign.response.status,403);
        // Статус исполняется, пока мастер остаётся открытым: очередь не занята ожиданием ввода.
        assert.equal((await status()).ready,false);const saved=await opened.save({token:secret});assert.equal(saved.response.status,200);assert.equal(saved.data.ready,true);readyStatus=await status();assert.equal(readyStatus.ready,true);assert.ok(readyStatus.revision);assert.notEqual(readyStatus.revision,initialStatus.revision);await noSecrets();
    });
    await check('Две одновременно открытые формы не перезаписывают новую ревизию локальной настройки',async()=>{
        const first=await form();const second=await form();assert.equal(first.session.revision,second.session.revision);assert.equal((await first.save({token:secret})).response.status,200);const changed=await status();assert.notEqual(changed.revision,readyStatus.revision);assert.equal((await second.save({token:'УСТАРЕВШАЯ_ЗАМЕНА'})).response.status,400);assert.equal((await status()).revision,changed.revision);readyStatus=changed;await noSecrets();
    });
    await check('Согласие на диагностику устаревшей ревизии настройки отклоняется до очереди',async()=>{
        await assert.rejects(f.create('probe-runtime',{consentManifest:approval.manifest,expectedConfigurationRevisions:[{assetId:childAssetId,manifest:f.childPkg.manifest.sha256,revision:null}]}),error=>error.status===409);
    });
    await check('Потерянный ACK открытия и статуса подтверждается повторно без повторной записи секрета',async()=>{
        const opened=await form({lostAck:true});assert.ok(f.committedAcks.has(opened.openedJob.id));f.lostAcks.delete(opened.openedJob.id);const next=await cfg('get-mcp-configuration-status');f.lostAcks.add(next.id);await f.run(next);assert.ok(f.committedAcks.has(next.id));f.lostAcks.delete(next.id);await status();assert.ok(f.completions.some(item=>item.id===opened.openedJob.id&&item.repeated));assert.ok(f.completions.some(item=>item.id===next.id&&item.repeated));assert.equal((await status()).revision,readyStatus.revision);
    });
    await check('Отзыв approval между открытием формы и SAVE сохраняет прежнюю конфигурацию',async()=>{
        const opened=await form();await f.devices.pool.query("UPDATE device_install_plans SET status='revoked' WHERE id=$1",[approval.id]);assert.equal((await opened.save({token:'ЗАМЕНА_ОТКЛОНЕНА'})).response.status,400);await f.devices.pool.query("UPDATE device_install_plans SET status='approved' WHERE id=$1",[approval.id]);assert.equal((await status()).revision,readyStatus.revision);
    });
    await check('Отзыв роли между открытием формы и SAVE не меняет локальные значения',async()=>{
        const opened=await form();f.setRoleAllowed(false);assert.equal((await opened.save({token:'ЗАМЕНА_РОЛЬ_ОТОЗВАНА'})).response.status,400);f.setRoleAllowed(true);assert.equal((await status()).revision,readyStatus.revision);
    });
    await check('Истёкшая подготовка блокирует позднее сохранение без продления TTL',async()=>{
        const opened=await form();await f.devices.pool.query("UPDATE bridge_jobs SET result=jsonb_set(result,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",[opened.preparationJob.id,new Date(Date.now()-1000).toISOString()]);assert.equal((await opened.save({token:'ЗАМЕНА_ПОСЛЕ_TTL'})).response.status,400);assert.equal((await status()).revision,readyStatus.revision);
    });
    await check('Смена binding на сервере после открытия формы блокирует SAVE',async()=>{
        const opened=await form();const report=(await f.devices.pool.query('SELECT report FROM bridge_devices WHERE id=$1',[f.deviceId])).rows[0].report;const changed=structuredClone(report);changed.bindings.find(item=>item.projectId===projectId).bindingId='0'.repeat(64);await f.devices.pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[f.deviceId,changed]);assert.equal((await opened.save({token:'ЗАМЕНА_ПОСЛЕ_BINDING'})).response.status,400);await f.devices.pool.query('UPDATE bridge_devices SET report=$2 WHERE id=$1',[f.deviceId,report]);assert.equal((await status()).revision,readyStatus.revision);
    });
    await check('Настоящая команда launcher из проектного конфига запускает настроенный дочерний MCP',async()=>{
        const receipt=JSON.parse(await fs.readFile(path.join(f.folderA,f.receipts.receiptPath(f.childPkg)),'utf8'));const [binary,...args]=receipt.config.value.command;const child=spawn(binary,args,{cwd:f.folderA,env:{...process.env,NEUROCENTER_BRIDGE_HOME:path.join(f.temporary,'bridge'),NEUROCENTER_URL:f.origin,HOME:path.join(f.temporary,'home'),USERPROFILE:path.join(f.temporary,'home')},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);const exit=once(child,'exit');
        try{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\n');const until=Date.now()+10000;while(!stdout.includes('"id":1')&&Date.now()<until&&child.exitCode===null)await delay(20);assert.ok(stdout.includes('"id":1'),stderr);assert.ok(!stdout.includes(secret)&&!stderr.includes(secret));}
        finally{child.stdin.end();await Promise.race([exit,delay(1000)]);if(child.exitCode===null){child.kill('SIGTERM');await exit;}}
    });
    await check('Диагностика запускает весь точный граф с локальным секретом дочернего MCP',async()=>{
        assert.ok(process.env.RELIABLE_V09_PROBE_ENGINE,'Для этого сценария требуется закреплённый настоящий движок.');const before=await snapshot(f.folderA);const job=await f.create('probe-runtime',{consentManifest:approval.manifest,expectedConfigurationRevisions:[{assetId:childAssetId,manifest:f.childPkg.manifest.sha256,revision:readyStatus.revision}]});const completed=await f.run(job);assert.equal(completed.result.status,'passed',JSON.stringify(completed.result));assert.equal(completed.result.code,'verified');assert.equal(completed.result.counts.packages,2);assert.equal(completed.result.counts.mcp,2);assert.deepEqual(await snapshot(f.folderA),before);
        const calls=(await fs.readFile(f.runtimeLog,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(calls.some(item=>item.name==='child'&&item.configured));assert.ok(calls.every(item=>!item.method||['initialize','notifications/initialized','tools/list','resources/list','prompts/list'].includes(item.method)));await noSecrets();
    });
    await check('Удаление обязательного ключа снимает готовность и требует новой настройки',async()=>{
        const opened=await form();const removed=await opened.save({}, {remove:['token']});assert.equal(removed.response.status,200);assert.equal(removed.data.ready,false);const missing=await status();assert.equal(missing.ready,false);assert.deepEqual(missing.missingFieldIds,['token']);const again=await form();assert.equal((await again.save({token:secret})).response.status,200);readyStatus=await status();assert.equal(readyStatus.ready,true);await noSecrets();
    });
    await check('Перезапуск worker сохраняет ревизию и секрет только в закрытом локальном хранилище',async()=>{await f.stopWorker();const current=await status();assert.equal(current.revision,readyStatus.revision);assert.equal(current.ready,true);await noSecrets();});
}catch(error){fatal=error.message;if(!fixture&&error.cleanup)cleanup=error.cleanup;console.error(error.stack);}
finally{if(fixture)cleanup=await fixture.close();}
const report={checkedAt:new Date().toISOString(),database:fixture?.database,tests:results,fatal:fatal??null,cleanup,realProfileChanged:false,nativeFilePickerUsed:false,osBrowserUsed:false,runtimeCodeExecuted:results.some(item=>item.ok&&item.case.startsWith('Диагностика'))};
await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'worker-v09.json'),JSON.stringify(report,null,2)+'\n');
if(fatal||results.some(item=>!item.ok)||!cleanup?.ownDatabaseDropped||!cleanup?.originalDatabasesPreserved||!cleanup?.originalCatalogDataPreserved)process.exitCode=1;
