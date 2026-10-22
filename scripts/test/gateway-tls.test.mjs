import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {npmCli} from '../workspace/node-runtime.mjs';
import {withNpmBuildEnvironment} from '../workspace/npm-build-environment.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),gateway=path.join(root,'services/api-gateway');
const require=createRequire(path.join(gateway,'package.json')),ts=require('typescript');
const cleanEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_/i.test(key)&&!['NODE_TLS_REJECT_UNAUTHORIZED','NODE_OPTIONS','NPM_TOKEN','NODE_AUTH_TOKEN'].includes(key)));
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc gateway tls '));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}

test('Gateway npm config selects npmjs, disables certificate verification and preloads TLS=0 for lifecycle scripts',async t=>{
    const directory=await fixture(t),userconfig=path.join(directory,'user.npmrc'),globalconfig=path.join(directory,'global.npmrc');
    await fs.copyFile(path.join(gateway,'.npmrc'),path.join(directory,'.npmrc'));
    await fs.writeFile(userconfig,'');await fs.writeFile(globalconfig,'');
    await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'gateway-tls-fixture',private:true,scripts:{probe:'node probe.cjs'}}));
    await fs.mkdir(path.join(directory,'nested dependency'));
    await fs.writeFile(path.join(directory,'probe.cjs'),"const child=require('node:child_process').execFileSync(process.execPath,['-p','process.env.NODE_TLS_REJECT_UNAUTHORIZED'],{cwd:'nested dependency',encoding:'utf8'}).trim();console.log(JSON.stringify({tls:process.env.NODE_TLS_REJECT_UNAUTHORIZED,nested:child}));");
    const env=cleanEnvironment(),args=['--userconfig='+userconfig,'--globalconfig='+globalconfig];
    const config=spawnSync(process.execPath,[npmCli(),'config','list','--json',...args],{cwd:directory,env,encoding:'utf8'});
    assert.equal(config.status,0,config.stderr);const settings=JSON.parse(config.stdout);
    assert.equal(settings.registry,'https://registry.npmjs.org');assert.equal(settings['strict-ssl'],false);
    const child=spawnSync(process.execPath,[npmCli(),'run','probe','--silent',...args],{cwd:directory,env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{tls:'0',nested:'0'});
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
});

test('Compiled gateway entry applies TLS=0 before loading runtime validation or Nest',async()=>{
    const source=await fs.readFile(path.join(gateway,'src/main.ts'),'utf8');
    const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;
    const env={},stop=new Error('first import reached');let loaded=false;
    assert.throws(()=>vm.runInNewContext(javascript,{exports:{},process:{env},require:()=>{loaded=true;assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED,'0');throw stop;}}),error=>error===stop);
    assert.equal(loaded,true);
});

test('Actual dev npm commands apply the exception to gateway without changing other package environments',async()=>{
    const source=await fs.readFile(path.join(root,'scripts/dev.mjs'),'utf8'),tree=ts.createSourceFile('dev.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const functions=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&['run','installDependencies'].includes(node.name?.text)).map(node=>node.getText(tree)).join('\n');
    const calls=[],environment={NODE_TLS_REJECT_UNAUTHORIZED:'1',KEEP:'original'};
    const context=vm.createContext({root,node:process.execPath,path,process:{env:environment},npmCli:()=>'/fixture/npm-cli.js',withNpmBuildEnvironment,
        spawnSync:(command,args,options)=>{calls.push({command,args,options});return{status:0};}});
    vm.runInContext(functions,context);
    await vm.runInContext("installDependencies(path.join(root,'services/api-gateway'))",context);
    await vm.runInContext("installDependencies(path.join(root,'services/catalog-service'))",context);
    assert.equal(calls.length,2);
    assert.equal(calls[0].options.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');assert.equal(calls[0].options.env.NPM_CONFIG_STRICT_SSL,'false');
    assert.ok(calls[0].args.includes('--strict-ssl=false'));assert.ok(!calls[0].args.includes('--strict-ssl=true'));
    assert.equal(calls[1].options.env.NODE_TLS_REJECT_UNAUTHORIZED,'1');assert.ok(calls[1].args.includes('--strict-ssl=true'));
    assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED,'1');assert.equal(environment.NPM_CONFIG_STRICT_SSL,undefined);
});

test('Gateway npm TLS options connect to an actual self-signed HTTPS server; a normal Node child still rejects it',async t=>{
    const directory=await fixture(t),key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem');
    const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=localhost'],{encoding:'utf8'});
    assert.equal(generated.status,0,generated.stderr);
    const server=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},(_request,response)=>response.end('gateway-tls-ok'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const port=server.address().port,program=`require('https').get('https://127.0.0.1:${port}',response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>console.log(JSON.stringify({status:response.statusCode,body,tls:process.env.NODE_TLS_REJECT_UNAUTHORIZED})));}).on('error',error=>console.log(JSON.stringify({error:error.code})));`;
    const options=(await fs.readFile(path.join(gateway,'.npmrc'),'utf8')).match(/^node-options=(.+)$/m)[1];
    const probe=async(preload)=>{const child=spawn(process.execPath,['-e',program],{env:{...cleanEnvironment(),...(preload?{NODE_OPTIONS:options}:{})},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,stderr);return JSON.parse(stdout);};
    assert.ok((await probe(false)).error);assert.deepEqual(await probe(true),{status:200,body:'gateway-tls-ok',tls:'0'});
});
