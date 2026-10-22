import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
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

test('Real npm ignores hostile user/global/scoped config and inherited npm options',async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-hostile-npm-'));
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const home=path.join(folder,'host-home'),project=path.join(folder,'project'),globalconfig=path.join(folder,'global.npmrc');
    await fs.mkdir(home);await fs.mkdir(project);
    const hostile='registry=http://127.0.0.1:9/\n@fixture:registry=http://127.0.0.1:9/\nstrict-ssl=false\n';
    await fs.writeFile(path.join(home,'.npmrc'),hostile);await fs.writeFile(globalconfig,hostile);
    await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'isolated-build-fixture',version:'1.0.0',private:true}));
    await fs.writeFile(path.join(project,'package-lock.json'),JSON.stringify({name:'isolated-build-fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'isolated-build-fixture',version:'1.0.0'}}}));
    const environment={...process.env,HOME:home,USERPROFILE:home,NPM_CONFIG_GLOBALCONFIG:globalconfig,
        npm_config_registry:'http://127.0.0.1:9/',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/',
        'npm_config_@fixture:registry':'http://127.0.0.1:9/',NPM_CONFIG_STRICT_SSL:'false',NPM_CONFIG_OFFLINE:'true',
        NPM_TOKEN:'fixture-token',NODE_AUTH_TOKEN:'fixture-token',HTTPS_PROXY:'http://corporate-proxy.invalid:3128'};
    let isolatedHome;
    await withNpmBuildEnvironment(environment,async({env,args})=>{
        isolatedHome=env.HOME;assert.notEqual(env.HOME,home);assert.equal(env.USERPROFILE,env.HOME);
        assert.deepEqual(Object.keys(env).filter(key=>/^npm_config_/i.test(key)),[]);
        assert.equal(env.NPM_TOKEN,undefined);assert.equal(env.NODE_AUTH_TOKEN,undefined);
        assert.equal(env.HTTPS_PROXY,environment.HTTPS_PROXY);
        const config=JSON.parse(execFileSync(process.execPath,[npmCli(),'config','list','--json',...args],{cwd:project,env,encoding:'utf8'}));
        assert.equal(config.registry,'https://registry.npmjs.org/');assert.equal(config['strict-ssl'],true);
        assert.equal(config['@fixture:registry'],undefined);assert.equal(config.offline,false);
        assert.notEqual(config.userconfig,config.globalconfig);
        for(const file of [config.userconfig,config.globalconfig])assert.equal(await fs.readFile(file,'utf8'),'');
        execFileSync(process.execPath,[npmCli(),'ci','--offline','--no-audit','--no-fund',...args],{cwd:project,env,stdio:'pipe'});
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

test('Every Node Docker build pins npm registry and empty configs with the explicit gateway TLS exception',async()=>{
    assert.ok(dockerfiles.includes('frontend/Dockerfile'));assert.ok(dockerfiles.includes('services/catalog-service/snapshot-verifier.Dockerfile'));
    for(const file of dockerfiles){
        const source=await fs.readFile(path.join(root,file),'utf8'),gateway=file==='services/api-gateway/Dockerfile';
        assert.match(source,/ENV NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//,file);
        assert.match(source,/NPM_CONFIG_USERCONFIG=\/dev\/null/,file);
        assert.match(source,/NPM_CONFIG_GLOBALCONFIG=\/tmp\/neurocenter-empty-global\.npmrc/,file);
        assert.match(source,gateway?/NPM_CONFIG_STRICT_SSL=false/:/NPM_CONFIG_STRICT_SSL=true/,file);
        if(gateway){assert.match(source,/^ENV NODE_TLS_REJECT_UNAUTHORIZED=0$/m,file);assert.doesNotMatch(source,/strict-ssl=true/,file);}
        else assert.doesNotMatch(source,/strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED/,file);
        for(const command of source.matchAll(/\bRUN npm ci ([^\n]+)/g)){
            for(const flag of ['--registry=https://registry.npmjs.org/','--userconfig=/dev/null','--globalconfig=/tmp/neurocenter-empty-global.npmrc','--strict-ssl='+!gateway])assert.ok(command[1].includes(flag),file+' missing '+flag);
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
        const flags=source.match(/^RUN npm ci ([^\n]+)/m)[1].split(' ').filter(flag=>/^(?:--registry|--userconfig|--globalconfig|--strict-ssl)=/.test(flag));
        await fs.writeFile(path.join(directory,'probe.cjs'),`
            const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
            for(const name of ['.npmrc','.yarnrc','.yarnrc.yml','nested/.npmrc','nested/.yarnrc','nested/.yarnrc.yml'])assert.equal(fs.existsSync('/probe/'+name),false,name);
            assert.equal(process.env['npm_config_@fixture:registry'],undefined);
            const config=JSON.parse(execFileSync('npm',['config','list','--json',...${JSON.stringify(flags)}],{encoding:'utf8'}));
            assert.equal(config.registry,'https://registry.npmjs.org/');assert.equal(config['strict-ssl'],${!gateway});
            assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED,${gateway?"'0'":'undefined'});
            assert.equal(config['@fixture:registry'],undefined);assert.equal(config.userconfig,'/dev/null');
            assert.equal(config.globalconfig,'/tmp/neurocenter-empty-global.npmrc');
            console.log('NEUROCENTER_NPM_ISOLATION_OK');
        `);
        await fs.writeFile(path.join(directory,'Dockerfile'),`FROM ${image}\n${config}\n${tls}\nWORKDIR /probe\nCOPY . .\nRUN node probe.cjs\n`);
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
