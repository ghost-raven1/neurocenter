import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {nodeRuntime,npmCli} from '../workspace/node-runtime.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));

/** Run the actual Docker npm command with an owned, directly reaped npm process. */
function install(command,project,env){
    return new Promise((resolve,reject)=>{
        const child=spawn('/bin/sh',['-c',command.replace(/\bnpm ci\b/,'exec npm ci')],{
            cwd:project,env,stdio:['ignore','pipe','pipe'],timeout:15000,killSignal:'SIGKILL'}),output=[];
        child.stdout.on('data',chunk=>output.push(chunk));child.stderr.on('data',chunk=>output.push(chunk));
        child.once('error',reject);
        child.once('close',(status,signal)=>resolve({status,signal,output:Buffer.concat(output).toString()}));
    });
}

test('Actual verifier npm RUN validates HTTPS by default, accepts an explicit CA and permits the explicit TLS opt-out',{timeout:45000},async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),'nc-verifier-tls-'));
    t.after(()=>fs.rm(folder,{recursive:true,force:true}));
    const {node,version,env:runtimeEnv}=nodeRuntime(),npm=npmCli(runtimeEnv);
    assert.match(version,/^24\./);
    const bin=path.join(folder,'bin'),payload=path.join(folder,'payload'),key=path.join(folder,'test-key.pem'),cert=path.join(folder,'test-cert.pem');
    await fs.mkdir(bin);await fs.mkdir(path.join(payload,'package'),{recursive:true});
    // This ephemeral private key belongs only to the loopback test server.
    const config=path.join(folder,'openssl.cnf');
    await fs.writeFile(config,'[req]\ndistinguished_name=subject\nx509_extensions=extensions\nprompt=no\n[subject]\nCN=verifier-loopback-test\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-config',config],{encoding:'utf8',timeout:10000});
    assert.equal(generated.status,0,generated.stderr);
    const marker='VERIFIER_HTTPS_PACKAGE_INSTALLED';
    await fs.writeFile(path.join(payload,'package/package.json'),JSON.stringify({name:'verifier-tls-fixture',version:'1.0.0',main:'index.cjs'}));
    await fs.writeFile(path.join(payload,'package/index.cjs'),'module.exports='+JSON.stringify(marker)+';\n');
    const archive=path.join(folder,'fixture.tgz'),packed=spawnSync('tar',['-czf',archive,'-C',payload,'package'],{encoding:'utf8',timeout:5000});
    assert.equal(packed.status,0,packed.stderr);
    const bytes=await fs.readFile(archive),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64'),requests=[];
    const server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(request,response)=>{
        requests.push(request.url);
        if(request.url!=='/fixture.tgz'){response.writeHead(404);response.end();return;}
        response.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length});response.end(bytes);
    });
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const resolved=`https://127.0.0.1:${server.address().port}/fixture.tgz`;
    await fs.writeFile(path.join(bin,'npm'),'#!/bin/sh\nexec "$NC_TEST_NODE" "$NC_TEST_NPM" "$@"\n',{mode:0o700});
    const source=(await fs.readFile(path.join(root,'services/catalog-service/snapshot-verifier.Dockerfile'),'utf8')).replace(/\\\r?\n/g,' ');
    const command=source.match(/^RUN (NODE_TLS_REJECT_UNAUTHORIZED=[^\n]+npm ci[^\n]*)/m)?.[1];assert.ok(command,'Actual verifier npm RUN must be exercised');
    const defaultStrict=source.match(/^ARG NEUROCENTER_NPM_STRICT_SSL=(\S+)/m)?.[1]??'true';
    for(const scenario of [{name:'strict-no-ca',strict:defaultStrict,ca:false,success:false},{name:'strict-extra-ca',strict:'true',ca:true,success:true},{name:'explicit-no-verify',strict:'false',ca:false,success:true}]){
        await t.test(scenario.name,async()=>{
            const project=path.join(folder,scenario.name);await fs.mkdir(project);
            const manifest={name:'verifier-tls-consumer',version:'1.0.0',private:true,dependencies:{'verifier-tls-fixture':'1.0.0'}};
            await fs.writeFile(path.join(project,'package.json'),JSON.stringify(manifest));
            await fs.writeFile(path.join(project,'package-lock.json'),JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,packages:{'':manifest,'node_modules/verifier-tls-fixture':{version:'1.0.0',resolved,integrity}}}));
            // Whitelist the environment: user npmrc, proxy, tokens and TLS overrides never enter this process.
            const environment={PATH:[bin,path.dirname(node),'/usr/bin','/bin'].join(path.delimiter),HOME:project,CI:'1',
                NC_TEST_NODE:node,NC_TEST_NPM:npm,NEUROCENTER_NPM_STRICT_SSL:scenario.strict,NEUROCENTER_NPM_DIAGNOSTICS:'1',
                NPM_CONFIG_STRICT_SSL:defaultStrict,NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:path.join(project,'empty-global.npmrc'),NPM_CONFIG_CACHE:path.join(project,'cache'),
                ...(scenario.ca?{NODE_EXTRA_CA_CERTS:cert}:{})};
            const globalconfig=environment.NPM_CONFIG_GLOBALCONFIG;await fs.writeFile(globalconfig,'');
            // The Docker image owns /tmp; the host probe substitutes only that empty config's location.
            const isolatedCommand=command.replaceAll('/tmp/neurocenter-empty-global.npmrc',"'"+globalconfig.replaceAll("'","'\\''")+"'");
            const before=requests.length,result=await install(isolatedCommand,project,environment);
            assert.equal(result.signal,null,result.output);
            if(!scenario.success){
                assert.equal(result.status,1,result.output);
                assert.match(result.output,/npm error code DEPTH_ZERO_SELF_SIGNED_CERT/);
                assert.match(result.output,/self-signed certificate/);
                assert.equal(requests.length,before,'Rejected TLS must never reach the HTTPS request handler');
                await assert.rejects(fs.stat(path.join(project,'node_modules/verifier-tls-fixture/index.cjs')),{code:'ENOENT'});
            }else{
                assert.equal(result.status,0,result.output);
                assert.equal(requests.length,before+1,'Each isolated install downloads its HTTPS tarball');
                const installed=path.join(project,'node_modules/verifier-tls-fixture');
                assert.equal(JSON.parse(await fs.readFile(path.join(installed,'package.json'),'utf8')).version,'1.0.0');
                const probe=spawnSync(node,['-p','require('+JSON.stringify(path.join(installed,'index.cjs'))+')'],{env:environment,encoding:'utf8',timeout:5000});
                assert.equal(probe.status,0,probe.stderr);assert.equal(probe.stdout.trim(),marker);
            }
        });
    }
});
