import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,readFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationFixture} from './package-publication-rollback.fixture.mjs';

export {deferred,settled,until} from './tool-build-cancellation.fixture.mjs';
export {releaseCancellationLease} from './tool-build-cancellation-lease.mjs';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const output=path.join(root,'.run/skill-build-authorization-20261023');
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const phase=process.env.SKILL_BUILD_AUTHORIZATION_PHASE??'candidate';
assert.ok(['baseline','candidate'].includes(phase),'Choose the explicit authorization baseline or candidate phase.');
export async function deadline(promise,label,milliseconds=8000){
    let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out: '+label)),milliseconds);})]);}
    finally{clearTimeout(timer);}
}

/** Read all QA/source/artifact evidence before admitting any PostgreSQL resource. */
export async function inputHashes(){
    const candidate=process.env.SKILL_BUILD_AUTHORIZATION_CANDIDATE,receiptFile=process.env.SKILL_BUILD_AUTHORIZATION_SOURCE_RECEIPT;
    assert.ok(candidate&&path.isAbsolute(candidate));assert.ok(receiptFile&&path.isAbsolute(receiptFile));
    const freeze=JSON.parse(await readFile(receiptFile)),hashes={sourceReceipt:sha(await readFile(receiptFile))};
    for(const file of freeze.sourceFiles){
        assert.ok(!file.includes('..')&&!path.isAbsolute(file));
        const bytes=await readFile(path.join(candidate,file));assert.equal(sha(bytes),freeze.hashes[file]);
        hashes['candidate-source:'+file]=sha(bytes);hashes['live-source:'+file]=sha(await readFile(path.join(root,file)));
        if(phase==='candidate')assert.equal(hashes['live-source:'+file],hashes['candidate-source:'+file],'Candidate acceptance must match current source '+file);
    }
    const modules={
        'catalog-service':['package-build/package-build.service.js','package-build/package-build.repository.js','package-build/build-skill.js','package-build/skill-source.js','package-build/import-skill-publication.js','package-build/publication-deadline.js','asset-sources/local-skill-ingest.js','asset-sources/skill-adapter.js','asset-sources/asset-blob-store.js','asset-sources/import-worker.js','access/access-db.js','access/access-write-policy.js','access/security-events.js'],
        'skills-service':['skills/skills.service.js','skills/asset-import.controller.js','skills/asset-import.js','storage/fs-skills-storage.js','storage/skill-journal.js','storage/skill-audit-outbox.js'],
    };
    for(const [name,files]of Object.entries(modules)){
        const manifestFile=path.resolve(candidate,'..',name+'-artifacts.json'),manifest=JSON.parse(await readFile(manifestFile));hashes[name+'-manifest']=sha(await readFile(manifestFile));
        for(const file of files){const digest=sha(await readFile(path.join(candidate,'services',name,'dist',file)));assert.equal(digest,manifest.files[file]);hashes['compiled:'+name+'/'+file]=digest;}
    }
    for(const file of ['scripts/catalog-plugins/build.mjs','scripts/catalog-plugins/manifest.mjs','services/shared/feature-flags.cjs','services/shared/feature-client.cjs','services/shared/feature-policy.cjs','services/shared/feature-flag-catalog.json'])hashes['candidate-input:'+file]=sha(await readFile(path.join(candidate,file)));
    for(const file of ['skill-build-authorization.mjs','skill-build-authorization.fixture.mjs','package-publication-rollback.fixture.mjs','owned-postgres.fixture.mjs','tool-build-cancellation.fixture.mjs','tool-build-cancellation-lease.mjs'])hashes['qa:'+file]=sha(await readFile(path.join(root,'scripts/test',file)));
    return hashes;
}

/** Only owned regular files are inspected; a substituted symlink invalidates the evidence. */
export async function fileInventory(directory){
    const files=[];
    async function visit(folder){
        for(const item of await readdir(folder,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
            const filename=path.join(folder,item.name);assert.equal(item.isSymbolicLink(),false,'Owned evidence path became a symlink.');
            if(item.isDirectory())await visit(filename);else{assert.ok(item.isFile());const bytes=await readFile(filename);files.push({path:path.relative(directory,filename),sha256:sha(bytes),bytes:bytes.length});}
        }
    }
    await visit(directory);return files.sort((left,right)=>left.path.localeCompare(right.path));
}

/** Preserve existing PG ownership admission and allocate a mutable, authenticated flags fixture locally. */
export async function authorizationFixture(label,runDirectory){
    const aliases={PACKAGE_PUBLICATION_ROLLBACK_CONNECTION_FILE:'SKILL_BUILD_AUTHORIZATION_CONNECTION_FILE',PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE:'SKILL_BUILD_AUTHORIZATION_CANDIDATE',PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT:'SKILL_BUILD_AUTHORIZATION_SOURCE_RECEIPT'};
    const before={...process.env};for(const source of Object.values(aliases))assert.ok(process.env[source]&&path.isAbsolute(process.env[source]));
    for(const [target,source]of Object.entries(aliases))process.env[target]=process.env[source];
    process.env.PACKAGE_PUBLICATION_ROLLBACK_RECEIPT_NAME='b14-'+phase+'-'+label+'-'+randomUUID()+'.json';
    const restore=()=>{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);};
    let f,closePromise;
    const close=()=>closePromise??=(async()=>{try{return await f?.close();}finally{restore();}})();
    try{
        f=await publicationFixture();
        const own=path.join(runDirectory,label);await mkdir(own,{recursive:true,mode:0o700});process.env.RUNTIME_ARTIFACT_DIR=path.join(own,'runtime');
        const require=createRequire(path.join(process.env.SKILL_BUILD_AUTHORIZATION_CANDIDATE,'services/catalog-service/package.json'));
        const {FEATURE_FLAG_KEYS,evaluateFeatureFlags}=require(path.join(process.env.SKILL_BUILD_AUTHORIZATION_CANDIDATE,'services/shared/feature-flags.cjs'));
        const {readFeatures}=require(path.join(process.env.SKILL_BUILD_AUTHORIZATION_CANDIDATE,'services/shared/feature-client.cjs'));
        let configured=Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,true]));const requests=[];
        const server=createServer((request,response)=>{
            if(request.headers['x-neurocenter-internal']!==process.env.NEUROCENTER_INTERNAL_TOKEN){request.resume();response.writeHead(403).end();return;}
            if(request.url==='/internal/feature-flags/evaluated'){
                const evaluated=evaluateFeatureFlags(configured);requests.push({at:new Date().toISOString(),tool_builds:evaluated.flags.tool_builds,tool_catalog:evaluated.flags.tool_catalog});
                response.setHeader('content-type','application/json');response.end(JSON.stringify(evaluated));
            }else{request.resume();response.writeHead(request.url==='/internal/events'?204:404).end();}
        });
        f.extras.push(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        const origin='http://127.0.0.1:'+server.address().port;process.env.FEATURE_FLAGS_SERVICE_URL=origin;process.env.API_GATEWAY_URL=origin;
        const setBuilds=value=>{configured={...configured,tool_builds:value};};
        return {...f,own,flags:{setBuilds,read:()=>readFeatures(),requests},close};
    }catch(error){try{if(f)await close();else restore();}catch(cleanup){throw new AggregateError([error,cleanup],'Owned fixture initialization and cleanup failed',{cause:error});}throw error;}
}

/** A policy failure alone is insufficient: every revoked path must prove the native write happened afterward. */
export function causalAuthorizationRed(receipt){
    if(receipt.phase!=='baseline'||receipt.cases.length!==6)return false;
    const controls=receipt.cases.filter(item=>item.policy==='healthy'),revoked=receipt.cases.filter(item=>item.policy!=='healthy');
    return controls.length===2&&controls.every(item=>item.ok)&&revoked.length===4&&!receipt.cleanupErrors.length
        &&JSON.stringify(receipt.inputHashes)===JSON.stringify(receipt.finalInputHashes)
        &&revoked.every(item=>item.failure?.code==='ERR_ASSERTION'&&item.failure.message.startsWith('Revoked policy reached native skill write')
            &&Number.isInteger(item.edge?.waiter)&&Number.isInteger(item.edge?.blocker)&&item.edge.waiter!==item.edge.blocker&&item.edge.blockers.includes(item.edge.blocker)&&item.revokeBeforeUnlock===true&&item.blockedMs<4500
            &&item.effectivePolicy?.tool_catalog===true&&(item.policy==='role'?item.effectivePolicy.isMainAdmin===false&&item.effectivePolicy.tool_builds===true:item.effectivePolicy.isMainAdmin===true&&item.effectivePolicy.tool_builds===false)
            &&(item.path==='import'||!!item.fence?.publication_started_at)&&item.sqlTimeouts?.length===0
            &&item.native?.exists===true&&item.native.importRequestKey===item.preparedRequestKey&&item.nativeImports?.some(event=>event.completed&&event.order>item.policyOrder)
            &&item.retainedSource?.exact===true&&item.cleanup?.ownDatabaseDropped===true&&item.cleanup?.originalDatabasesPreserved===true&&!item.cleanup?.errors.length);
}
