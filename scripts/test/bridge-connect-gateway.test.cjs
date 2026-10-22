const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {Writable}=require('node:stream');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const panel="https://panel'fixture.test",api="https://gateway'fixture.test:8443";
const methods=[['connectScript','connect.sh'],['connectWindowsScript','connect.ps1']];
const cleanup=[];
class Response extends Writable{
    constructor(){super();this.headers={};this.parts=[];this.headersSent=false;this.on('error',()=>{});}
    _write(bytes,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(bytes));done();}
    setHeader(key,value){this.headers[key.toLowerCase()]=String(value);return this;}
    send(value){this.end(value);return this;}
    get text(){return Buffer.concat(this.parts).toString();}
}
const request=()=>Object.assign(new EventEmitter(),{query:{},headers:{host:'spoofed.test','x-forwarded-host':'spoofed.test',forwarded:'host=spoofed.test;proto=http'},aborted:false});
const status=expected=>error=>error.getStatus?.()===expected;
function environment(t,key,value){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}
function detached(req,res){assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}

/** Native template files and failing source methods prove connect never needs an imported archive. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-bridge-connect-gateway-')));
    t.after(async()=>{await fs.rm(root,{recursive:true,force:true});cleanup.push(root);});
    environment(t,'BRIDGE_TEMPLATES_DIR',root);environment(t,'PANEL_URL',panel+'/ignored-path');environment(t,'API_PUBLIC_URL',api);
    const template="SITE='__SITE_URL__'\nBASE='__BASE_URL__'\nRECONNECT='__RECONNECT__'\n__BRIDGE_CONTEXT__\n__BRIDGE_CONNECT__\n";
    const context="// Context literal $& $` $' $$; keep byte-for-byte\n",connect="// Connect literal $& $` $' $$; keep byte-for-byte\n";
    for(const file of ['connect.sh','connect.ps1'])await fs.writeFile(path.join(root,file),template);
    await fs.writeFile(path.join(root,'context.cjs'),context);await fs.writeFile(path.join(root,'connect.cjs'),connect);
    const calls=[],service=Object.fromEntries(['supply','developmentSupply','runtime'].map(method=>[method,async()=>{calls.push(method);throw Error('Catalog/assets unavailable tripwire');}]));
    return{root,template,context,connect,calls,controller:new BridgeController(service)};
}

test('Both connection routes are registered on the public bridge controller',()=>{
    assert.deepEqual(Reflect.getMetadata('path',BridgeController),['bridge','api/bridge']);
    for(const [method,file]of methods){assert.equal(typeof BridgeController.prototype[method],'function');assert.equal(Reflect.getMetadata('path',BridgeController.prototype[method]),file);}
});
for(const [method,file]of methods)test(file+' renders trusted origins and literal helpers while every supply operation is unavailable',async t=>{
    const f=await fixture(t),req=request(),res=new Response();req.query.reconnect='1';await f.controller[method](req,res);
    const quote=value=>value.replace(/'/g,file.endsWith('.sh')?"'\"'\"'":"''");
    assert.equal(res.text,"SITE='"+quote(panel)+"'\nBASE='"+quote(api+'/api/bridge')+"'\nRECONNECT='1'\n"+f.context+'\n'+f.connect+'\n');
    assert.equal(/__BRIDGE_|__SITE_URL__|__BASE_URL__|__RECONNECT__|spoofed.test/.test(res.text),false);
    assert.equal(res.headers['cache-control'],'no-store');assert.equal(res.headers['content-type'],file.endsWith('.sh')?'text/x-shellscript; charset=utf-8':'text/plain; charset=utf-8');
    assert.deepEqual(f.calls,[]);detached(req,res);
});
test('Only the exact reconnect query opts into reconnect',async t=>{
    const f=await fixture(t);
    for(const query of [{},{reconnect:'true'},{reconnect:['1']}]){const req=request(),res=new Response();req.query=query;await f.controller.connectScript(req,res);assert.ok(res.text.includes("RECONNECT='0'"));detached(req,res);}
    assert.deepEqual(f.calls,[]);
});
test('A self-contained installer keeps its supplied version without requiring any helper file',async t=>{
    const f=await fixture(t),req=request(),res=new Response(),calls=[];
    await fs.writeFile(path.join(f.root,'install.sh'),"VERSION='__BRIDGE_VERSION__'\nSITE='__SITE_URL__'\nBASE='__BASE_URL__'\nRECONNECT='__RECONNECT__'\n");
    await fs.unlink(path.join(f.root,'context.cjs'));await fs.unlink(path.join(f.root,'connect.cjs'));
    const controller=new BridgeController({supply:async()=>{calls.push('supply');return{version:'9.8.7'};}}),reads=[],read=controller.read.bind(controller);
    t.mock.method(controller,'read',async file=>{reads.push(file);return read(file);});await controller.installScript(req,res);
    assert.ok(res.text.includes("VERSION='9.8.7'"));assert.ok(res.text.includes("SITE='https://panel'\"'\"'fixture.test'"));
    assert.equal(/__(?:BRIDGE_[A-Z_]+|BASE_URL|SITE_URL|RECONNECT)__/.test(res.text),false);
    assert.deepEqual(reads,['install.sh']);assert.deepEqual(calls,['supply']);assert.deepEqual(f.calls,[]);detached(req,res);
});
for(const file of ['context.cjs','connect.cjs'])test('A missing '+file+' fails closed without sending a partial command',async t=>{
    const f=await fixture(t),req=request(),res=new Response();await fs.unlink(path.join(f.root,file));
    await assert.rejects(f.controller.connectScript(req,res),status(404));assert.equal(res.text,'');assert.deepEqual(f.calls,[]);detached(req,res);
});
for(const token of ['__BRIDGE_CONTEXT__','__BRIDGE_CONNECT__'])for(const copies of [0,2])test(token+' with '+copies+' copies refuses the connection template',async t=>{
    const f=await fixture(t),req=request(),res=new Response();await fs.writeFile(path.join(f.root,'connect.sh'),f.template.replace(token,token.repeat(copies)));
    await assert.rejects(f.controller.connectScript(req,res),status(404));assert.equal(res.text,'');assert.deepEqual(f.calls,[]);detached(req,res);
});
test('An unresolved nested helper placeholder is never served as executable text',async t=>{
    const f=await fixture(t),req=request(),res=new Response();await fs.writeFile(path.join(f.root,'connect.cjs'),'__BRIDGE_MISSING_HELPER__');
    await assert.rejects(f.controller.connectScript(req,res),status(404));assert.equal(res.text,'');assert.deepEqual(f.calls,[]);detached(req,res);
});
test('A disconnected request performs no template or supply read',async t=>{
    const f=await fixture(t),req=request(),res=new Response();req.aborted=true;let reads=0;t.mock.method(f.controller,'read',async()=>{reads++;throw Error('unexpected template read');});
    await f.controller.connectScript(req,res);assert.equal(reads,0);assert.equal(res.text,'');assert.deepEqual(f.calls,[]);detached(req,res);
});
for(const mode of ['request','response'])test('Cancellation during context read stops later helper reads and a retry remains independent: '+mode,async t=>{
    const f=await fixture(t),req=request(),res=new Response(),reads=[],read=f.controller.read.bind(f.controller);let cancelled=false;
    t.mock.method(f.controller,'read',async file=>{reads.push(file);const bytes=await read(file);if(file==='context.cjs'&&!cancelled){cancelled=true;if(mode==='request'){req.aborted=true;req.emit('aborted');}else res.destroy();}return bytes;});
    await f.controller.connectScript(req,res);assert.equal(cancelled,true);assert.deepEqual(reads,['connect.sh','context.cjs']);assert.equal(res.text,'');detached(req,res);
    const next=request(),response=new Response();await f.controller.connectScript(next,response);assert.ok(response.text.includes(f.connect));assert.deepEqual(f.calls,[]);detached(next,response);
});
test('Actual shipped connection templates expand completely without reading any supply',async t=>{
    environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));environment(t,'PANEL_URL',panel);environment(t,'API_PUBLIC_URL',api);
    const controller=new BridgeController({supply:async()=>{throw Error('unexpected Catalog request');}});
    for(const [method]of methods){const req=request(),res=new Response();await controller[method](req,res);assert.equal(/__(?:BRIDGE_[A-Z_]+|BASE_URL|SITE_URL|RECONNECT)__/.test(res.text),false);assert.ok(res.text.includes('https://gateway'));assert.ok(res.text.includes('https://panel'));detached(req,res);}
});
after(async()=>{if(process.env.BRIDGE_CONNECT_GATEWAY_CLEANUP)await fs.writeFile(process.env.BRIDGE_CONNECT_GATEWAY_CLEANUP,JSON.stringify({roots:cleanup,remaining:cleanup.filter(root=>require('node:fs').existsSync(root))})+'\n',{flag:'wx',mode:0o600});});
