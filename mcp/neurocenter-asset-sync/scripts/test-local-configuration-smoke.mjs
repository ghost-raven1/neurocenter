import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bindProject, setRoot } from '../dist/bridge/workspace.js';
import { canonicalV4 } from '../dist/bridge/package.js';
import { hash, writeState } from '../dist/bridge/state.js';
import { install } from '../dist/bridge/installer.js';
import { configurationConnection } from '../dist/features/local-configuration/launcher-descriptor.js';
import { prepareMcpConfiguration, openMcpConfiguration, getMcpConfigurationStatus } from '../dist/features/local-configuration/index.js';
import { closeConfigurationSessions } from '../dist/features/local-configuration/server.js';

// Отдельный build-smoke использует только собственную временную папку и фиктивный локальный ключ.
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-local-config-smoke-')));
const root = path.join(temporary,'projects','project'); const secret = randomBytes(24).toString('hex'); const noop = async()=>{};
process.env.NEUROCENTER_BRIDGE_HOME=path.join(temporary,'private'); process.env.NEUROCENTER_URL='http://localhost:5173';
const cases=[]; let remote; let client; let transport;
function pkg(id,config,source) {
    const files=source ? [{path:'index.mjs',content:source,size:Buffer.byteLength(source),sha256:hash(source)}] : [];
    const plugin={id,name:id,kind:'mcp',version:1};
    return {schemaVersion:5,plugin,config,files,manifest:{filesCount:files.length,sha256:hash(JSON.stringify(canonicalV4({schemaVersion:5,plugin,config,files:files.map(({path,size,sha256})=>({path,size,sha256}))})))}};
}
async function configure(target) {
    await install('smoke-project',target,noop,noop); const prepared=await prepareMcpConfiguration('smoke-project',target,undefined,noop);let url;
    const opened=await openMcpConfiguration('smoke-project',target,undefined,{...prepared,authorizeSave:noop,open:async value=>{url=new URL(value);return true;}},noop);
    assert.equal(opened.opened,true); assert.ok(!JSON.stringify(opened).includes(secret));
    const post=(route,body,csrf='')=>fetch(url.origin+route,{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json','X-Configuration-CSRF':csrf},body:JSON.stringify(body)});
    const form=await (await post('/session',{token:url.hash.slice(1)})).json();
    assert.ok(!JSON.stringify(form).includes(secret));
    const saved=await post('/save',{updates:{key:secret},remove:[],expectedRevision:form.revision},form.csrf);assert.equal(saved.status,200);
    const status=await getMcpConfigurationStatus('smoke-project',target,undefined,noop);assert.equal(status.ready,true);assert.ok(!JSON.stringify(status).includes(secret));
    const config=await fs.readFile(path.join(root,'opencode.json'),'utf8');assert.ok(!config.includes(secret));
    return configurationConnection(root,target).command;
}
async function connect(command,expectedName) {
    assert.ok(!command.some(value=>value.includes(secret)));
    transport=new StdioClientTransport({command:command[0],args:command.slice(1),stderr:'pipe',env:{...process.env}});
    let stderr=''; transport.stderr?.on('data',chunk=>{stderr+=chunk;});
    client=new Client({name:'local-configuration-smoke',version:'1'},{capabilities:{}});
    await client.connect(transport,{timeout:10000});assert.equal(client.getServerVersion().name,expectedName);
    assert.deepEqual((await client.listTools(undefined,{timeout:10000})).tools,[]);assert.ok(!stderr.includes(secret));
    await client.close();await transport.close();client=undefined;transport=undefined;
}
try {
    await fs.mkdir(root,{recursive:true});await setRoot(path.dirname(root));await bindProject('smoke-project','project');
    await writeState('credentials',{deviceId:'smoke-configuration-device',email:'smoke@example.org',token:'isolated-smoke-only'});
    const local=pkg('smoke-local-config',{command:'node',entrypoint:'index.mjs',extra:{localConfiguration:{schemaVersion:1,fields:[{id:'key',label:'Тестовый ключ',type:'string',secret:true,required:true,target:{kind:'env',name:'SMOKE_PRIVATE_KEY'}}]}}},
        `import readline from 'node:readline';if(!process.env.SMOKE_PRIVATE_KEY)process.exit(23);readline.createInterface({input:process.stdin}).on('line',raw=>{const r=JSON.parse(raw);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,serverInfo:{name:'local-configured',version:'1'},capabilities:{tools:{}}}:{tools:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+String.fromCharCode(10));});`);
    await connect(await configure(local),'local-configured');cases.push({name:'Локальный launcher передаёт параметры через окружение и проходит MCP handshake',passed:true});
    let remoteRequests=0;
    remote=createServer((request,response)=>{void(async()=>{
        if(request.method!=='POST'){response.writeHead(405);response.end();return;}
        assert.equal(request.headers.authorization,'Bearer '+secret);let body='';for await(const chunk of request)body+=chunk;
        const message=JSON.parse(body);remoteRequests++;if(message.id===undefined){response.writeHead(202);response.end();return;}
        const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,serverInfo:{name:'remote-configured',version:'1'},capabilities:{tools:{}}}:{tools:[]};
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    })().catch(()=>{response.writeHead(403);response.end();});});
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));const address=remote.address();
    const target=pkg('smoke-remote-config',{transport:'remote',url:`http://127.0.0.1:${address.port}/mcp`,oauth:false,extra:{localConfiguration:{schemaVersion:1,fields:[{id:'key',label:'Тестовый ключ',type:'string',secret:true,required:true,target:{kind:'header',name:'Authorization',prefix:'Bearer '}}]}}});
    await connect(await configure(target),'remote-configured');assert.ok(remoteRequests>=3);
    cases.push({name:'Удалённый stdio-прокси добавляет закрытый заголовок только одобренному URL',passed:true});
    assert.equal(process.env.SMOKE_PRIVATE_KEY,undefined);cases.push({name:'Параметры отсутствуют в конфиге проекта, аргументах и публичных результатах',passed:true});
    console.log(JSON.stringify({schemaVersion:1,passed:cases.length,total:cases.length,cases},null,2));
} finally {
    await client?.close().catch(()=>{});await transport?.close().catch(()=>{});closeConfigurationSessions();
    if(remote){remote.closeAllConnections();await new Promise(resolve=>remote.close(resolve));}
    await fs.rm(temporary,{recursive:true,force:true});
}
