import assert from 'node:assert/strict';
import {createHash,X509Certificate} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {rootCertificates} from 'node:tls';
import {fileURLToPath} from 'node:url';
import {withDockerBuildCa} from '../workspace/docker-build-ca.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const contexts=['docker/build-ca','frontend/docker/build-ca'];
const publicCa=rootCertificates[0];
const sourceFiles=['frontend/Dockerfile','services/api-gateway/Dockerfile','services/catalog-service/Dockerfile',
    'services/catalog-service/snapshot-verifier.Dockerfile','services/feature-flags-service/Dockerfile',
    'services/oauth2-bridge/Dockerfile','services/rag-sync-service/Dockerfile','services/skills-service/Dockerfile'];

async function fixture(t){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc docker ca '));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    for(const context of contexts){await fs.mkdir(path.join(directory,context),{recursive:true});await fs.writeFile(path.join(directory,context,'.gitkeep'),'');}
    const ca=path.join(directory,'public CA.pem');await fs.writeFile(ca,publicCa);
    return {directory,ca,environment:{NEUROCENTER_BUILD_CA_FILE:ca}};
}

async function noStagedFiles(directory){
    for(const context of contexts){await assert.rejects(fs.stat(path.join(directory,context,'extra.pem')),{code:'ENOENT'});}
}

test('No configured CA needs no generated files and clears inherited build hash',async t=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc no ca '));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    await withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_SHA256:'a'.repeat(64)},async({environment,args})=>{
        assert.equal(environment.NEUROCENTER_BUILD_CA_SHA256,'');assert.deepEqual(args,[]);
    });
    assert.deepEqual(await fs.readdir(directory),[]);
});

test('Only public certificates are staged in both contexts; Docker receives SHA, no PEM or npm settings',async t=>{
    const {directory,ca,environment}=await fixture(t);
    const result=await withDockerBuildCa(directory,{...environment,NPM_TOKEN:'fixture-secret'},async({environment:env,args})=>{
        for(const context of contexts){
            const bytes=await fs.readFile(path.join(directory,context,'extra.pem'),'utf8');
            assert.deepEqual(new X509Certificate(bytes).raw,new X509Certificate(publicCa).raw);assert.equal(createHash('sha256').update(bytes).digest('hex'),env.NEUROCENTER_BUILD_CA_SHA256);
        }
        assert.match(env.NEUROCENTER_BUILD_CA_SHA256,/^[a-f0-9]{64}$/);
        assert.deepEqual(args,['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+env.NEUROCENTER_BUILD_CA_SHA256]);
        assert.ok(!args.join(' ').includes('CERTIFICATE'));assert.ok(!args.join(' ').includes('fixture-secret'));return 17;
    });
    assert.equal(result,17);await noStagedFiles(directory);assert.equal(await fs.readFile(ca,'utf8'),publicCa);
});

test('A failed Docker action removes its staged CA, preserving source',async t=>{
    const {directory,ca,environment}=await fixture(t);
    await assert.rejects(withDockerBuildCa(directory,environment,()=>{throw Error('fixture Docker failed');}),/fixture Docker failed/);
    await noStagedFiles(directory);assert.equal(await fs.readFile(ca,'utf8'),publicCa);
});

test('NODE_EXTRA_CA_CERTS is an explicit fallback and dedicated setting takes priority',async t=>{
    const {directory,ca}=await fixture(t);
    for(const env of [{NODE_EXTRA_CA_CERTS:ca},{NEUROCENTER_BUILD_CA_FILE:ca,NODE_EXTRA_CA_CERTS:'/missing'}]){
        await withDockerBuildCa(directory,env,({args})=>assert.equal(args.length,2));await noStagedFiles(directory);
    }
});

test('Private keys, garbage, malformed, empty and oversized files fail before Docker',async t=>{
    const {directory,ca}=await fixture(t);
    for(const bytes of ['',publicCa+'\n-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
        publicCa+'\nregistry=http://host.invalid/', '-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----','x'.repeat(1024*1024+1)]){
        await fs.writeFile(ca,bytes);let called=false;
        await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:ca},()=>{called=true;}));
        assert.equal(called,false);await noStagedFiles(directory);
    }
});

test('PEM bundles are supported and the certificate count is bounded',async t=>{
    const {directory,ca}=await fixture(t);
    await fs.writeFile(ca,publicCa.replaceAll('\n','\r\n')+'\r\n'+rootCertificates[1]);
    await withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:ca},async()=>{
        const text=await fs.readFile(path.join(directory,contexts[0],'extra.pem'),'utf8');
        assert.equal([...text.matchAll(/BEGIN CERTIFICATE/g)].length,2);
    });
    await fs.writeFile(ca,Array(257).fill(publicCa).join('\n'));
    await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:ca},()=>assert.fail('Docker must not run')));
    await noStagedFiles(directory);
});

test('A server certificate without CA permission is rejected',async t=>{
    const {directory,ca}=await fixture(t),key=path.join(directory,'private key');
    const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
        '-subj','/CN=fixture.local','-addext','basicConstraints=critical,CA:FALSE','-keyout',key,'-out',ca],{encoding:'utf8',timeout:10000});
    assert.equal(generated.status,0,generated.stderr);
    await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:ca},()=>assert.fail('Docker must not run')),/центром сертификации/);
    await noStagedFiles(directory);
});

test('Missing files, symlinks, hardlinks, directories and control characters are rejected',async t=>{
    const {directory,ca}=await fixture(t);
    const linked=path.join(directory,'linked.pem');await fs.symlink(ca,linked);
    for(const selected of [path.join(directory,'missing'),linked,directory,'\n']){
        await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:selected},()=>assert.fail('Docker must not run')));
    }
    await fs.rm(linked);await fs.link(ca,linked);
    await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:linked},()=>assert.fail('Docker must not run')));
    await noStagedFiles(directory);
});

test('A FIFO cannot hang CA preparation before its file type is checked',{skip:process.platform==='win32',timeout:5000},async t=>{
    const {directory}=await fixture(t),fifo=path.join(directory,'ca.fifo');
    const result=spawnSync('mkfifo',[fifo],{encoding:'utf8',timeout:1000});assert.equal(result.status,0,result.stderr);
    await assert.rejects(withDockerBuildCa(directory,{NEUROCENTER_BUILD_CA_FILE:fifo},()=>assert.fail('Docker must not run')),/обычный PEM/);
    await noStagedFiles(directory);
});

test('A stale or concurrent staged file is never overwritten or removed',async t=>{
    const {directory,environment}=await fixture(t),stale=path.join(directory,contexts[1],'extra.pem');
    await fs.writeFile(stale,'foreign file');
    await assert.rejects(withDockerBuildCa(directory,environment,()=>assert.fail('Docker must not run')),/уже есть extra.pem/);
    assert.equal(await fs.readFile(stale,'utf8'),'foreign file');
    await assert.rejects(fs.stat(path.join(directory,contexts[0],'extra.pem')),{code:'ENOENT'});
});

test('Cleanup preserves a file replaced during a Docker build',async t=>{
    const {directory,environment}=await fixture(t),filename=path.join(directory,contexts[0],'extra.pem');
    await withDockerBuildCa(directory,environment,async()=>{await fs.rm(filename);await fs.writeFile(filename,'foreign replacement');});
    assert.equal(await fs.readFile(filename,'utf8'),'foreign replacement');
    await assert.rejects(fs.stat(path.join(directory,contexts[1],'extra.pem')),{code:'ENOENT'});
});

test('A FIFO replacing a staged file cannot hang cleanup',{skip:process.platform==='win32',timeout:5000},async t=>{
    const {directory,environment}=await fixture(t),filename=path.join(directory,contexts[0],'extra.pem');
    await withDockerBuildCa(directory,environment,async()=>{
        await fs.rm(filename);assert.equal(spawnSync('mkfifo',[filename],{timeout:1000}).status,0);
    });
    assert.equal((await fs.lstat(filename)).isFIFO(),true);
});

test('Compose build CLI stages CA for its Docker process and cleans up after success or failure',async t=>{
    const {directory,ca}=await fixture(t),scripts=path.join(directory,'scripts'),bin=path.join(directory,'bin');
    await fs.mkdir(path.join(scripts,'workspace'),{recursive:true});await fs.mkdir(bin);
    for(const file of ['docker-build.mjs','workspace/docker-build-ca.mjs']){
        await fs.copyFile(path.join(root,'scripts',file),path.join(scripts,file));
    }
    const calls=path.join(directory,'calls.jsonl');
    await fs.writeFile(path.join(bin,'docker'),`#!${process.execPath}
        const fs=require('fs'),crypto=require('crypto');
        const bytes=fs.readFileSync('docker/build-ca/extra.pem');
        if(crypto.createHash('sha256').update(bytes).digest('hex')!==process.env.NEUROCENTER_BUILD_CA_SHA256)process.exit(29);
        fs.appendFileSync(process.env.CA_CALLS,JSON.stringify({args:process.argv.slice(2),sha:process.env.NEUROCENTER_BUILD_CA_SHA256})+'\\n');
        process.exit(Number(process.env.CA_EXIT));
    `,{mode:0o755});
    for(const code of [0,31]){
        const result=spawnSync(process.execPath,[path.join(scripts,'docker-build.mjs'),'compose','build','frontend'],{
            env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,NEUROCENTER_BUILD_CA_FILE:ca,CA_CALLS:calls,CA_EXIT:String(code)},encoding:'utf8',timeout:10000});
        assert.equal(result.status,code===0?0:1,result.stderr);await noStagedFiles(directory);
    }
    const records=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2);
    for(const record of records){assert.deepEqual(record.args,['compose','build','frontend']);assert.match(record.sha,/^[a-f0-9]{64}$/);}
});

test('All Node Dockerfiles verify optional CA before npm and preserve the explicit gateway TLS exception',async()=>{
    for(const file of sourceFiles){
        const source=await fs.readFile(path.join(root,file),'utf8');
        assert.match(source,/ARG NEUROCENTER_BUILD_CA_SHA256/,file);
        assert.match(source,/COPY docker\/build-ca\/ \/usr\/local\/share\/neurocenter\/build-ca\//,file);
        assert.match(source,/sha256sum --check --status/,file);assert.match(source,/chmod 0444/,file);
        assert.match(source,/: > \/usr\/local\/share\/neurocenter\/build-ca\/extra.pem/,file);
        assert.ok(source.indexOf('ENV NODE_EXTRA_CA_CERTS=')<source.indexOf('RUN npm ci'),file);
        if(file==='services/api-gateway/Dockerfile'){
            assert.match(source,/^ENV NODE_TLS_REJECT_UNAUTHORIZED=0$/m,file);
            assert.match(source,/NPM_CONFIG_STRICT_SSL=false/,file);assert.match(source,/--strict-ssl=false/,file);
            assert.doesNotMatch(source,/strict-ssl=true/,file);
        }else assert.doesNotMatch(source,/strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED/,file);
    }
    for(const file of ['docker-compose.yml','compose.production.yml']){
        const source=await fs.readFile(path.join(root,file),'utf8');
        assert.equal([...source.matchAll(/NEUROCENTER_BUILD_CA_SHA256: /g)].length,file==='docker-compose.yml'?7:8,file);
    }
});

test('Catalog system trust splits a PEM bundle into one certificate per CRT before HTTPS downloads',async t=>{
    const {directory}=await fixture(t),source=await fs.readFile(path.join(root,'services/catalog-service/Dockerfile'),'utf8');
    assert.ok(source.indexOf('update-ca-certificates;')<source.indexOf('curl -fsSL https://'), 'curl must receive the configured CA');
    assert.ok(source.indexOf('update-ca-certificates;')<source.indexOf('https://apt.postgresql.org/'), 'HTTPS apt must receive the configured CA');
    const program=source.match(/awk '([^']+)' "\$NODE_EXTRA_CA_CERTS"/)[1];
    const output=path.join(directory,'system-ca');await fs.mkdir(output);
    execFileSync('awk',[program.replace('/usr/local/share/ca-certificates/',output+'/')],{input:publicCa+'\n'+rootCertificates[1]+'\n'});
    const names=(await fs.readdir(output)).sort();assert.deepEqual(names,['neurocenter-build-1.crt','neurocenter-build-2.crt']);
    for(const name of names){const text=await fs.readFile(path.join(output,name),'utf8');assert.equal([...text.matchAll(/BEGIN CERTIFICATE/g)].length,1);assert.equal(new X509Certificate(text).ca,true);}
});

test('Real legacy and BuildKit Docker builds accept CA, reject mismatched SHA and ignore stale CA without SHA',
    {skip:process.env.DOCKER_BUILD_CA_TEST!=='1',timeout:180000},async t=>{
        const {directory,environment}=await fixture(t);
        const source=await fs.readFile(path.join(root,'services/catalog-service/snapshot-verifier.Dockerfile'),'utf8');
        const preamble=source.split('# Ignore user/global npm settings;')[0];
        const probe=preamble+"USER node\nRUN node -e \"const assert=require('assert/strict'),tls=require('tls'); assert.equal(tls.getCACertificates('extra').length, Number(process.env.EXPECT_EXTRA));console.log('CA_PROBE_OK')\"\n";
        const images=[];t.after(()=>{for(const image of images){spawnSync('docker',['image','rm',image],{stdio:'ignore'});}});
        for(const builder of ['0','1']){
            const image='neurocenter-ca-probe:'+process.pid+'-'+builder;images.push(image);
            const build=args=>spawnSync('docker',['build','--pull=false','-t',image,...args,'.'],{cwd:directory,env:{...process.env,DOCKER_BUILDKIT:builder},encoding:'utf8',timeout:60000});
            const setProbe=async count=>fs.writeFile(path.join(directory,'Dockerfile'),probe.replace('USER node','ENV EXPECT_EXTRA='+count+'\nUSER node'));
            await setProbe(0);let result=build([]);assert.equal(result.status,0,result.stdout+result.stderr);
            await withDockerBuildCa(directory,environment,async({args})=>{
                await setProbe(1);result=build(args);assert.equal(result.status,0,result.stdout+result.stderr);
                result=build(['--build-arg','NEUROCENTER_BUILD_CA_SHA256='+'0'.repeat(64)]);assert.notEqual(result.status,0);
                await setProbe(0);result=build([]);assert.equal(result.status,0,result.stdout+result.stderr);
            });
        }
    });
