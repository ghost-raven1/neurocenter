import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));

test('Both frontend compose builds include the shared registry without host dependencies or npm credentials',async()=>{
    const dev=await fs.readFile(path.join(root,'docker-compose.yml'),'utf8'),production=await fs.readFile(path.join(root,'compose.production.yml'),'utf8');
    assert.match(dev,/frontend:\s*build:\s*context: \.\s*dockerfile: frontend\/Dockerfile/);
    assert.match(production,/build: \{context: \., dockerfile: frontend\/Dockerfile/);
    const ignore=await fs.readFile(path.join(root,'.dockerignore'),'utf8');
    assert.doesNotMatch(ignore,/^frontend\/$/m);
    for(const entry of ['**/node_modules','**/dist','**/.env*','**/.npmrc'])assert.ok(ignore.split('\n').includes(entry),entry);
});

test('Real BuildKit frontend Dockerfile resolves the canonical registry and publishes its generated dist',
    {skip:process.env.FRONTEND_BUILD_CONTEXT_TEST!=='1',timeout:120000},async t=>{
        const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-frontend-context-')),tag='neurocenter-frontend-context:'+process.pid;
        t.after(async()=>{spawnSync('docker',['image','rm',tag],{stdio:'ignore'});await fs.rm(directory,{recursive:true,force:true});});
        for(const folder of ['frontend','services/shared','docker/build-ca'])await fs.mkdir(path.join(directory,folder),{recursive:true});
        await fs.copyFile(path.join(root,'.dockerignore'),path.join(directory,'.dockerignore'));
        await fs.copyFile(path.join(root,'frontend/Dockerfile'),path.join(directory,'frontend/Dockerfile'));
        for(const name of ['feature-flag-catalog.json','feature-flags.d.cts'])await fs.copyFile(path.join(root,'services/shared',name),path.join(directory,'services/shared',name));
        for(const name of ['nginx.conf','nginx.production.conf.template'])await fs.copyFile(path.join(root,'frontend',name),path.join(directory,'frontend',name));
        await fs.writeFile(path.join(directory,'docker/build-ca/.gitkeep'),'');
        await fs.writeFile(path.join(directory,'frontend/package.json'),JSON.stringify({name:'frontend-build-context',version:'1.0.0',scripts:{build:'node verify.cjs'}}));
        await fs.writeFile(path.join(directory,'frontend/package-lock.json'),JSON.stringify({name:'frontend-build-context',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'frontend-build-context',version:'1.0.0'}}}));
        for(const name of ['.npmrc','frontend/.npmrc'])await fs.writeFile(path.join(directory,name),'registry=http://127.0.0.1:9/\nstrict-ssl=false\n');
        await fs.writeFile(path.join(directory,'frontend/verify.cjs'),`const fs=require('fs'),assert=require('assert/strict');
            const definitions=require('../services/shared/feature-flag-catalog.json');assert.ok(definitions.some(flag=>flag.key==='research_tools'));
            assert.ok(fs.existsSync('../services/shared/feature-flags.d.cts'));assert.equal(fs.existsSync('.npmrc'),false);
            fs.mkdirSync('dist');fs.writeFileSync('dist/index.html','FEATURE_REGISTRY_'+definitions.length);console.log('FRONTEND_CONTEXT_OK');`);
        const build=spawnSync('docker',['build','--network=none','--pull=false','--no-cache','--progress=plain','-f','frontend/Dockerfile','-t',tag,'.'],{
            cwd:directory,env:{...process.env,DOCKER_BUILDKIT:'1'},encoding:'utf8',timeout:90000});
        assert.equal(build.status,0,build.stdout+build.stderr);assert.match(build.stdout+build.stderr,/FRONTEND_CONTEXT_OK/);
        const probe=spawnSync('docker',['run','--rm','--network=none','--entrypoint','cat',tag,'/usr/share/nginx/html/index.html'],{encoding:'utf8',timeout:15000});
        assert.equal(probe.status,0,probe.stderr);assert.match(probe.stdout,/^FEATURE_REGISTRY_\d+$/);
    });
