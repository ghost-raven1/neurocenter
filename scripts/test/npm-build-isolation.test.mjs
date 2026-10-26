import assert from 'node:assert/strict';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {npmCli} from '../workspace/node-runtime.mjs';
import {withNpmBuildEnvironment} from '../workspace/npm-build-environment.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const tracked=execFileSync('git',['ls-files'],{cwd:root,encoding:'utf8'}).trim().split('\n');
const dockerfiles=tracked.filter(file=>/(?:^|\/)Dockerfile$|\.Dockerfile$/.test(file));

for(const mode of ['normal','transient','permanent'])test('Real verifier npm RUN uses a single connection and bounded retries: '+mode,{timeout:20000},async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-verifier-serial-')),events=[];let active=0,maximum=0,rejected=0;
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const payload=path.join(folder,'payload'),project=path.join(folder,'project'),bin=path.join(folder,'bin');
    for(const directory of [payload,project,bin])await fs.mkdir(directory);
    await fs.mkdir(path.join(payload,'package'));await fs.writeFile(path.join(payload,'package/package.json'),JSON.stringify({name:'download-fixture',version:'1.0.0'}));
    const archive=path.join(folder,'fixture.tgz');execFileSync('tar',['-czf',archive,'-C',payload,'package']);const bytes=await fs.readFile(archive),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
    const server=createServer((request,response)=>{
        active++;maximum=Math.max(maximum,active);events.push(request.url);
        if(active>1){rejected++;active--;response.writeHead(503);response.end('Only one active transfer is available');return;}
        if(mode==='permanent'||mode==='transient'&&events.length===1){rejected++;active--;response.writeHead(503);response.end('Controlled registry outage');return;}
        setTimeout(()=>{active--;response.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length});response.end(bytes);},100);
    });
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const dependencies={},packages={'':{name:'verifier-network-fixture',version:'1.0.0',dependencies}};
    for(let index=0;index<(mode==='permanent'?1:4);index++){
        const name='download-fixture-'+index;dependencies[name]='1.0.0';packages['node_modules/'+name]={version:'1.0.0',resolved:`http://127.0.0.1:${server.address().port}/${name}.tgz`,integrity};
    }
    await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'verifier-network-fixture',version:'1.0.0',private:true,dependencies}));
    await fs.writeFile(path.join(project,'package-lock.json'),JSON.stringify({name:'verifier-network-fixture',version:'1.0.0',lockfileVersion:3,packages}));
    await fs.writeFile(path.join(bin,'npm'),'#!/bin/sh\nexec "$NC_TEST_NODE" "$NC_TEST_NPM" "$@"\n',{mode:0o700});
    const source=(await fs.readFile(path.join(root,'services/catalog-service/snapshot-verifier.Dockerfile'),'utf8')).replace(/\\\r?\n/g,' ');
    const command=source.match(/^RUN (NODE_TLS_REJECT_UNAUTHORIZED=[^\n]+npm ci[^\n]*)/m)?.[1];assert.ok(command);
    const result=await new Promise((resolve,reject)=>{
        // Replace the shell with the owned npm process so the native timeout kills and reaps it.
        const child=spawn('/bin/sh',['-c',command.replace(/\bnpm ci\b/,'exec npm ci')],{cwd:project,timeout:15000,killSignal:'SIGKILL',env:{PATH:bin+path.delimiter+path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin',HOME:folder,NEUROCENTER_NPM_STRICT_SSL:'true',NEUROCENTER_NPM_DIAGNOSTICS:mode==='normal'?'0':'1',NC_TEST_NODE:process.execPath,NC_TEST_NPM:npmCli(),NPM_CONFIG_CACHE:path.join(folder,'fresh-cache')}}),chunks=[];
        child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal,output:Buffer.concat(chunks).toString()}));
    });
    assert.equal(result.status,mode==='permanent'?1:0,JSON.stringify({maximum,rejected,events,...result}));assert.equal(result.signal,null);
    assert.equal(maximum,1);assert.equal(rejected,mode==='permanent'?2:mode==='transient'?1:0);assert.equal(events.length,mode==='permanent'?2:mode==='transient'?5:4);
    if(mode==='permanent'){assert.match(result.output,/npm error code E503/);return;}
    for(const name of Object.keys(dependencies))assert.equal(JSON.parse(await fs.readFile(path.join(project,'node_modules',name,'package.json'),'utf8')).version,'1.0.0');
});

test('Snapshot verifier installs only its SDK closure with the existing Catalog pins and integrity',async()=>{
    const directory=path.join(root,'scripts/snapshots/verifier'),manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
    const lock=JSON.parse(await fs.readFile(path.join(directory,'package-lock.json'),'utf8')),catalog=JSON.parse(await fs.readFile(path.join(root,'services/catalog-service/package-lock.json'),'utf8'));
    assert.deepEqual(manifest.dependencies,{'@lancedb/lancedb':'0.29.0','apache-arrow':'18.1.0'});
    assert.deepEqual(lock.packages[''].dependencies,manifest.dependencies);
    assert.equal(Object.keys(lock.packages).length,37);
    for(const [key,item]of Object.entries(lock.packages)){
        if(!key)continue;
        const original=catalog.packages[key];assert.ok(original,key);
        for(const field of ['version','resolved','integrity','os','cpu','libc','optional'])assert.deepEqual(item[field],original[field],key+' '+field);
        assert.equal(new URL(item.resolved).hostname,'registry.npmjs.org');assert.ok(item.integrity);assert.ok(!item.dev&&!item.peer,key);
    }
    const source=await fs.readFile(path.join(root,'services/catalog-service/snapshot-verifier.Dockerfile'),'utf8');
    assert.match(source,/COPY scripts\/snapshots\/verifier\/package.json scripts\/snapshots\/verifier\/package-lock.json/);
    assert.doesNotMatch(source,/COPY services\/catalog-service\/package/);
});

test('Real npm pins relaxed build TLS despite hostile config and preserves lifecycle isolation',async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-hostile-npm-'));
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const home=path.join(folder,'host-home'),project=path.join(folder,'project'),globalconfig=path.join(folder,'global.npmrc');
    await fs.mkdir(home);await fs.mkdir(project);
    const hostile='registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nstrict-ssl=true\n';
    await fs.writeFile(path.join(home,'.npmrc'),hostile);await fs.writeFile(globalconfig,hostile);
    await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'isolated-build-fixture',version:'1.0.0',private:true,scripts:{postinstall:'node tls-probe.cjs'}}));
    await fs.writeFile(path.join(project,'tls-probe.cjs'),`const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');assert.equal(execFileSync(process.execPath,[process.env.npm_execpath,'config','get','strict-ssl'],{encoding:'utf8'}).trim(),'false');assert.equal(process.env.NPM_TOKEN,undefined);assert.equal(process.env.NODE_AUTH_TOKEN,undefined);console.log('BUILD_TLS_LIFECYCLE_OK');\n`);
    await fs.writeFile(path.join(project,'package-lock.json'),JSON.stringify({name:'isolated-build-fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'isolated-build-fixture',version:'1.0.0'}}}));
    const environment={...process.env,HOME:home,USERPROFILE:home,CI:'1',PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,NPM_CONFIG_GLOBALCONFIG:globalconfig,
        npm_config_registry:'http://127.0.0.1:9/',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/',
        'npm_config_@fixture:registry':'http://127.0.0.1:9/',NPM_CONFIG_STRICT_SSL:'true',npm_config_strict_ssl:'true',NODE_TLS_REJECT_UNAUTHORIZED:'1',NPM_CONFIG_OFFLINE:'true',
        NPM_TOKEN:'fixture-token',NODE_AUTH_TOKEN:'fixture-token',HTTPS_PROXY:'http://corporate-proxy.invalid:3128'};
    let isolatedHome;
    await withNpmBuildEnvironment(environment,async({env,args})=>{
        isolatedHome=env.HOME;assert.notEqual(env.HOME,home);assert.equal(env.USERPROFILE,env.HOME);
        assert.deepEqual(Object.keys(env).filter(key=>/^npm_config_/i.test(key)).sort(),['NPM_CONFIG_STRICT_SSL','npm_config_strict_ssl']);
        assert.equal(env.NPM_CONFIG_STRICT_SSL,'false');assert.equal(env.npm_config_strict_ssl,'false');assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
        assert.equal(env.NPM_TOKEN,undefined);assert.equal(env.NODE_AUTH_TOKEN,undefined);
        assert.equal(env.HTTPS_PROXY,environment.HTTPS_PROXY);
        const config=JSON.parse(execFileSync(process.execPath,[npmCli(),'config','list','--json',...args],{cwd:project,env,encoding:'utf8'}));
        assert.equal(config.registry,'https://registry.npmjs.org/');assert.equal(config['strict-ssl'],false);
        assert.equal(config['@fixture:registry'],undefined);assert.equal(config.offline,false);
        assert.notEqual(config.userconfig,config.globalconfig);
        for(const file of [config.userconfig,config.globalconfig])assert.equal(await fs.readFile(file,'utf8'),'');
        const output=execFileSync(process.execPath,[npmCli(),'ci','--offline','--no-audit','--no-fund',...args],{cwd:project,env,encoding:'utf8'});
        assert.match(output,/BUILD_TLS_LIFECYCLE_OK/);
    });
    await assert.rejects(fs.stat(isolatedHome),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(home,'.npmrc'),'utf8'),hostile);
    assert.equal(await fs.readFile(globalconfig,'utf8'),hostile);
});

test('Temporary npm configuration is removed after a failed build',async()=>{
    let home;
    await assert.rejects(withNpmBuildEnvironment(process.env,async({env})=>{home=env.HOME;throw Error('fixture-build-failed');}),/fixture-build-failed/);
    await assert.rejects(fs.stat(home),{code:'ENOENT'});
});

test('Every Node Docker build pins npm registry, empty configs and its selected build TLS policy',async()=>{
    assert.ok(dockerfiles.includes('frontend/Dockerfile'));assert.ok(dockerfiles.includes('services/catalog-service/snapshot-verifier.Dockerfile'));
    for(const file of dockerfiles){
        const source=await fs.readFile(path.join(root,file),'utf8'),gateway=file==='services/api-gateway/Dockerfile',verifier=file==='services/catalog-service/snapshot-verifier.Dockerfile';
        assert.match(source,/ENV NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//,file);
        assert.match(source,/NPM_CONFIG_USERCONFIG=\/dev\/null/,file);
        assert.match(source,/NPM_CONFIG_GLOBALCONFIG=\/tmp\/neurocenter-empty-global\.npmrc/,file);
        assert.match(source,verifier?/NPM_CONFIG_STRICT_SSL=true/:/NPM_CONFIG_STRICT_SSL=false/,file);
        if(!verifier)assert.doesNotMatch(source,/STRICT_SSL=true|strict-ssl=true/,file);
        if(gateway)assert.match(source,/^ENV NODE_TLS_REJECT_UNAUTHORIZED=0$/m,file);
        else assert.doesNotMatch(source,/^ENV [^\n]*NODE_TLS_REJECT_UNAUTHORIZED=/m,file);
        const commands=[...source.matchAll(/^RUN ([^\n]+)/gm)].flatMap(match=>match[1].split(/\s*&&\s*/)).filter(command=>/\bnpm\s/.test(command));
        assert(commands.length>0,file);
        for(const command of commands){
            assert.match(command,verifier?/^NODE_TLS_REJECT_UNAUTHORIZED=.*NPM_CONFIG_STRICT_SSL="\$NEUROCENTER_NPM_STRICT_SSL" NODE_NO_WARNINGS=1 npm ci/:/^NODE_TLS_REJECT_UNAUTHORIZED=0 (?:[A-Z_]+=\S+ )*npm /,file+' missing build TLS: '+command);
            if(!/\bnpm ci /.test(command))continue;
            for(const flag of ['--registry=https://registry.npmjs.org/','--userconfig=/dev/null','--globalconfig=/tmp/neurocenter-empty-global.npmrc',verifier?'--strict-ssl="$NEUROCENTER_NPM_STRICT_SSL"':'--strict-ssl=false'])assert.ok(command.includes(flag),file+' missing '+flag);
        }
        assert.doesNotMatch(source,/^\s*(?:ARG|COPY|ADD)\s+[^\n]*(?:npm_config_|\.npmrc|\.yarnrc)/im,file);
    }
});

test('Real Docker contexts reject host npmrc/scoped registry contamination', {skip:process.env.NPM_DOCKER_ISOLATION!=='1',timeout:120000},async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-docker-npm-'));
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    for(const [index,{dockerfile,ignore}]of [
        {dockerfile:'services/api-gateway/Dockerfile',ignore:'.dockerignore'},
        {dockerfile:'frontend/Dockerfile',ignore:'.dockerignore'},
    ].entries()){
        const directory=path.join(folder,String(index));await fs.mkdir(path.join(directory,'nested'),{recursive:true});
        await fs.copyFile(path.join(root,ignore),path.join(directory,'.dockerignore'));
        for(const file of ['.npmrc','.yarnrc','.yarnrc.yml','nested/.npmrc','nested/.yarnrc','nested/.yarnrc.yml'])await fs.writeFile(path.join(directory,file),'registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nstrict-ssl=false\n');
        const source=await fs.readFile(path.join(root,dockerfile),'utf8');
        const image=source.match(/^ARG NODE_IMAGE=(.+)$/m)[1],config=source.match(/^ENV NPM_CONFIG_REGISTRY=[\s\S]*?NPM_CONFIG_STRICT_SSL=(?:true|false)/m)[0];
        const gateway=dockerfile==='services/api-gateway/Dockerfile',tls=source.match(/^ENV NODE_TLS_REJECT_UNAUTHORIZED=0$/m)?.[0]||'';
        const flags=source.match(/^RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npm ci ([^\n]+)/m)[1].split(' ').filter(flag=>/^(?:--registry|--userconfig|--globalconfig|--strict-ssl)=/.test(flag));
        await fs.writeFile(path.join(directory,'probe.cjs'),`
            const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
            for(const name of ['.npmrc','.yarnrc','.yarnrc.yml','nested/.npmrc','nested/.yarnrc','nested/.yarnrc.yml'])assert.equal(fs.existsSync('/probe/'+name),false,name);
            assert.equal(process.env['npm_config_@fixture:registry'],undefined);
            const config=JSON.parse(execFileSync('npm',['config','list','--json',...${JSON.stringify(flags)}],{encoding:'utf8'}));
            assert.equal(config.registry,'https://registry.npmjs.org/');assert.equal(config['strict-ssl'],false);
            assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
            assert.equal(config['@fixture:registry'],undefined);assert.equal(config.userconfig,'/dev/null');
            assert.equal(config.globalconfig,'/tmp/neurocenter-empty-global.npmrc');
            console.log('NEUROCENTER_NPM_ISOLATION_OK');
        `);
        await fs.writeFile(path.join(directory,'Dockerfile'),`FROM ${image}\n${config}\n${tls}\nWORKDIR /probe\nCOPY . .\nRUN NODE_TLS_REJECT_UNAUTHORIZED=0 node probe.cjs\nRUN node -e "require('node:assert/strict').equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,${gateway?"'0'":'undefined'})"\n`);
        const tag='neurocenter-npm-isolation-'+process.pid+'-'+index;
        try{
            const result=spawnSync('docker',['build','--network=none','--pull=false','--no-cache','--progress=plain','--tag',tag,directory],{
                env:{...process.env,NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/',NPM_CONFIG_USERCONFIG:'/host/private/npmrc',
                    'npm_config_@fixture:registry':'http://127.0.0.1:9/'},encoding:'utf8',stdio:'pipe',timeout:60000});
            const output=result.stdout+result.stderr;
            assert.equal(result.status,0,output);assert.match(output,/NEUROCENTER_NPM_ISOLATION_OK/);
        }finally{if(spawnSync('docker',['image','inspect',tag],{stdio:'pipe'}).status===0)execFileSync('docker',['image','rm',tag],{stdio:'pipe'});}
    }
});

test('All image build contexts exclude registry settings and credentials at every depth',async()=>{
    const ignores=tracked.filter(file=>path.basename(file)==='.dockerignore');
    assert.ok(ignores.includes('.dockerignore'));assert.ok(ignores.includes('frontend/.dockerignore'));
    for(const file of ignores){
        const source=await fs.readFile(path.join(root,file),'utf8');
        for(const pattern of ['**/.npmrc','**/.yarnrc','**/.yarnrc.yml'])assert.ok(source.split(/\r?\n/).includes(pattern),file+' missing '+pattern);
    }
    for(const file of ['docker-compose.yml','compose.production.yml','compose.snapshots.yml','compose.embedding.yml']){
        const source=await fs.readFile(path.join(root,file),'utf8');
        assert.doesNotMatch(source,/\b(?:NPM_CONFIG_|npm_config_|NPM_TOKEN|NODE_AUTH_TOKEN)/,file);
    }
});

test('Locked package downloads use npmjs or pinned GitHub asset sources',async()=>{
    for(const file of tracked.filter(file=>file.endsWith('package-lock.json'))){
        const lock=JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
        for(const item of Object.values(lock.packages||{})){
            if(!item.resolved||!item.resolved.includes('://'))continue;
            const url=new URL(item.resolved);assert.equal(url.protocol,'https:',file);
            assert.ok(['registry.npmjs.org','codeload.github.com'].includes(url.hostname),file);
            if(url.hostname==='codeload.github.com')assert.match(url.pathname,/\/[a-f0-9]{40}$/);
        }
    }
});
