import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationFixture} from './package-publication-rollback.fixture.mjs';
export {deferred,settled,until} from './tool-build-cancellation.fixture.mjs';
export {releaseCancellationLease} from './tool-build-cancellation-lease.mjs';
export const root=fileURLToPath(new URL('../../',import.meta.url)),output=path.join(root,'.run/actor-canonical-publication-20261023');
export const phase=process.env.ACTOR_CANONICAL_PUBLICATION_PHASE??'candidate';
assert.ok(['baseline','candidate'].includes(phase));
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const failure=error=>({name:error.name,message:error.message,code:error.code,status:error.getStatus?.()??error.status});
export async function deadline(promise,label,ms=10000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}

/** Admit exact source and compiled manifests before creating any PostgreSQL fixture. */
export async function inputHashes(){
    const candidate=process.env.ACTOR_CANONICAL_PUBLICATION_CANDIDATE,file=process.env.ACTOR_CANONICAL_PUBLICATION_SOURCE_RECEIPT;
    assert.ok(candidate&&path.isAbsolute(candidate));assert.ok(file&&path.isAbsolute(file));const bytes=await readFile(file),freeze=JSON.parse(bytes),hashes={sourceReceipt:sha(bytes)};
    for(const name of freeze.sourceFiles){
        assert.ok(!path.isAbsolute(name)&&!name.includes('..'));const frozen=sha(await readFile(path.join(candidate,name))),live=sha(await readFile(path.join(root,name)));assert.equal(frozen,freeze.hashes[name]);
        if(phase==='candidate')assert.equal(live,frozen,'Candidate source is stale: '+name);hashes['candidate-source:'+name]=frozen;hashes['live-source:'+name]=live;
    }
    const selected={
        'catalog-service':['package-build/package-build.service.js','package-build/package-build.repository.js','package-build/package-build.model.js','package-build/package-build.controller.js','package-build/build-skill.js','package-build/import-skill-publication.js','asset-sources/local-skill-ingest.js','asset-sources/skill-adapter.js','asset-sources/asset-blob-store.js','asset-sources/import-worker.js','asset-sources/import-repository.js','access/access-db.js','access/access.model.js','access/access.controller.js','access/access-write-policy.js'],
        'skills-service':['skills/skills.service.js','skills/asset-import.controller.js','skills/asset-import.js','storage/fs-skills-storage.js','storage/skill-journal.js','storage/skill-audit-outbox.js'],
        'oauth2-bridge':['auth/auth.service.js','auth/roles.js'],
        'api-gateway':['proxy/proxy.service.js','auth/auth-guard.service.js'],
    };
    for(const [name,files]of Object.entries(selected)){
        const manifestBytes=await readFile(path.resolve(candidate,'..',name+'-artifacts.json')),manifest=JSON.parse(manifestBytes);hashes['manifest:'+name]=sha(manifestBytes);
        for(const relative of files){const digest=sha(await readFile(path.join(candidate,'services',name,'dist',relative)));assert.equal(digest,manifest.files[relative]);hashes['compiled:'+name+'/'+relative]=digest;}
    }
    for(const relative of ['scripts/catalog-plugins/build.mjs','services/shared/feature-flags.cjs','services/shared/feature-client.cjs','services/shared/feature-policy.cjs','services/shared/feature-flag-catalog.json'])hashes['candidate-input:'+relative]=sha(await readFile(path.join(candidate,relative)));
    for(const name of ['actor-canonical-publication.mjs','actor-canonical-publication.fixture.mjs','package-publication-rollback.fixture.mjs','owned-postgres.fixture.mjs','tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs'])hashes['qa:'+name]=sha(await readFile(path.join(root,'scripts/test',name)));
    return hashes;
}

/** Real profile HTTP delegates the actual internal controller; raw session identity is never rewritten. */
export async function actorFixture(label,directory){
    const before={...process.env},aliases={PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE:'ACTOR_CANONICAL_PUBLICATION_CANDIDATE',PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT:'ACTOR_CANONICAL_PUBLICATION_SOURCE_RECEIPT',PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE:'ACTOR_CANONICAL_PUBLICATION_CONNECTION_FILE'};
    for(const source of Object.values(aliases))assert.ok(process.env[source]&&path.isAbsolute(process.env[source]));for(const [target,source]of Object.entries(aliases))process.env[target]=process.env[source];
    process.env.PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME='b15-'+phase+'-'+label+'-'+randomUUID()+'.json';
    const restore=()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);};let f,closed;
    const close=()=>closed??=(async()=>{try{return await f?.close();}finally{restore();}})();
    try{
        f=await publicationFixture();const own=path.join(directory,label);await mkdir(own,{recursive:true,mode:0o700});process.env.RUNTIME_ARTIFACT_DIR=path.join(own,'runtime');
        process.env.NO_PROXY=[before.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');process.env.no_proxy=process.env.NO_PROXY;
        const require=createRequire(path.join(process.env.ACTOR_CANONICAL_PUBLICATION_CANDIDATE,'services/catalog-service/package.json'));
        const loadPackage=(name,file)=>require(path.join(process.env.ACTOR_CANONICAL_PUBLICATION_CANDIDATE,'services',name,'dist',file));let access;
        const profileRequests=[],server=createServer(async(request,response)=>{
            request.resume();const url=new URL(request.url,'http://127.0.0.1');if(url.pathname!=='/internal/access/profile'){response.writeHead(404).end();return;}
            const entry={rawEmail:url.searchParams.get('email')};profileRequests.push(entry);
            try{const controller=new(f.load('access/access.controller.js').AccessController)(access),claims=await controller.profile(request.headers['x-neurocenter-internal'],entry.rawEmail);Object.assign(entry,{canonicalEmail:claims.email,roles:claims.userRoles,status:200});response.setHeader('content-type','application/json');response.end(JSON.stringify(claims));}
            catch(error){entry.status=error.getStatus?.()??500;entry.error=failure(error);response.writeHead(entry.status,{'content-type':'application/json'}).end(JSON.stringify({message:error.message}));}
        });
        f.extras.push(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        process.env.CATALOG_SERVICE_URL='http://127.0.0.1:'+server.address().port;
        async function identity(service,raw){
            access=service.access;process.env.DEV_USER_EMAIL=raw;const Auth=loadPackage('oauth2-bridge','auth/auth.service.js').AuthService,auth=new Auth({get:key=>key==='SSO_DISABLE'?'true':undefined});
            const user=await auth.mockUser();assert.equal(user.email,raw);assert.equal(user.principalName,raw);assert.equal(user.activeRole,'Главный админ');
            const Proxy=loadPackage('api-gateway','proxy/proxy.service.js').ProxyService,proxy=new Proxy({get:()=>undefined},{},{});
            const headers=proxy.buildHeaders({}, {...user,userId:user.id,policies:auth.policies(user.activeRole)}),request={headers};
            const controller=new(f.load('package-build/package-build.controller.js').PackageBuildController)(service),actor=controller.actor(request);assert.equal(actor.email,raw);
            return {user,actor,request,controller,trace:{rawEmail:raw,mockEmail:user.email,mockPrincipal:user.principalName,actorEmail:actor.email,profile:structuredClone(profileRequests.at(-1))}};
        }
        return {...f,own,identity,profileRequests,close};
    }catch(error){try{if(f)await close();else restore();}catch(cleanup){throw new AggregateError([error,cleanup],'Actor fixture initialization and cleanup failed',{cause:error});}throw error;}
}

/** Generic failures cannot stand in for the four exact raw-lookup publication failures. */
export function causalActorRed(receipt){
    if(receipt.phase!=='baseline'||receipt.cases.length!==9||receipt.cleanupErrors.length||JSON.stringify(receipt.inputHashes)!==JSON.stringify(receipt.finalInputHashes))return false;
    const raw=receipt.cases.filter(item=>item.type==='publication'&&item.format!=='canonical'),healthy=receipt.cases.filter(item=>item.type!=='publication'||item.format==='canonical');
    return raw.length===4&&healthy.length===5&&healthy.every(item=>item.ok)&&raw.every(item=>
        item.failure?.code==='ERR_ASSERTION'&&item.failure.message.startsWith('Authorized raw principal failed skill publication')
        &&item.identity.rawEmail===item.identity.mockEmail&&item.identity.rawEmail===item.identity.mockPrincipal&&item.identity.rawEmail===item.identity.actorEmail
        &&item.identity.profile.canonicalEmail===item.canonical&&item.identity.profile.roles.includes('Главный админ')
        &&item.roleRows.canonical?.is_main_admin===true&&item.roleRows.canonical.enabled===true&&item.roleRows.raw===null
        &&(item.mode==='build'?item.job.state==='FAILED'&&item.job.error==='Права главного администратора отозваны. Публикация остановлена.':item.operation.error?.status===403&&item.operation.error.message==='Права главного администратора отозваны. Импорт остановлен.')
        &&item.native.exists===false&&item.nativePublishes.length===0&&item.sourceRows.versions===0&&item.sourceRows.receipts===0&&item.retainedSource.exact
        &&item.cleanup?.ownDatabaseDropped&&item.cleanup.originalDatabasesPreserved&&!item.cleanup.errors.length);
}
