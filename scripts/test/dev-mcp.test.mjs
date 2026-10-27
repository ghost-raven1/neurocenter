import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,symlink,link} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDiagnostics,validateWorkspace} from '../dev-mcp/diagnostics.mjs';
import {readOwnedFile} from '../dev-mcp/safe-file.mjs';
import {redactLog} from '../dev-mcp/redact.mjs';
import {healthReader} from '../dev-mcp/health.mjs';
import {packages,services} from '../dev-mcp/constants.mjs';
import {expectedToolNames,serverVersion} from '../dev-mcp/tool-catalog.mjs';
import {captureCheckSource,checkSourceResult} from '../workspace/check-source.mjs';
import {launchFixture} from './dev-launch.fixture.mjs';
import {stopWatchGroup} from '../workspace/dev-watch-owned.mjs';

const require=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url));
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const serverUrl=new URL('../dev-mcp/server.mjs',import.meta.url).href;
const directory=fileURLToPath(new URL('../../',import.meta.url));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,ms=3000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}}

async function fixture(t){
    const parent=await realpath(await mkdtemp(path.join(tmpdir(),'neurocenter-dev-mcp test-'))),root=path.join(parent,'workspace with spaces');
    await mkdir(root);t.after(()=>rm(parent,{recursive:true,force:true}));
    await writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    await writeFile(path.join(root,'.gitignore'),'.run/\n');
    for(const [name,folder]of packages){await mkdir(path.join(root,folder),{recursive:true});await writeFile(path.join(root,folder,'package.json'),JSON.stringify({version:'0.10.1',
        scripts:{typecheck:'fixture',build:'fixture',...(name==='frontend'?{test:'vitest run'}:{})}}));}
    const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
    git(['init','-q','-b','main']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']);
    const head=git(['rev-parse','HEAD']);
    const report={schemaVersion:2,profile:'unit-safe',coverageKind:'vitest-ast-v8',comparablePercentages:true,startedAt:'2026-10-23T00:00:00Z',finishedAt:'2026-10-23T00:01:00Z',complete:true,
        sourceBefore:{head,status:''},sourceAfter:{head,status:''},sourceChangedDuringRun:false,
        packages:[{name:'catalog-service',passed:10,failed:0,skipped:0,todo:0,exitCode:0,excludedInfrastructureSuites:[],testFileInventory:{complete:true},reportValidation:{ok:true}}],
        summary:Object.fromEntries(['lines','statements','functions','branches'].map(key=>[key,{total:100,covered:80,skipped:0,pct:80}])),
        denominator:{allWorkspaceSourcesIncluded:false,configuredPackageSourcesIncluded:false,httpOnlyExecutedSources:true,fileInventoryIsNotLineCoverage:true},sourceFiles:1};
    const reportPath='.run/coverage/final/manifest.json';await mkdir(path.join(root,'.run/coverage/final'),{recursive:true});
    const saveReport=async value=>writeFile(path.join(root,reportPath),JSON.stringify(value));await saveReport(report);
    await mkdir(path.join(root,'.run/logs'),{recursive:true});
    return {parent,root,head,report,reportPath,saveReport,diagnostics:await createDiagnostics(root)};
}

test('workspace identity is required before diagnostics and links cannot impersonate a workspace',async t=>{
    const f=await fixture(t);await validateWorkspace(f.root);
    await writeFile(path.join(f.root,'package.json'),'{}');await assert.rejects(createDiagnostics(f.root),error=>error.code==='WORKSPACE_INVALID');
    const alias=path.join(f.parent,'alias');await symlink(f.root,alias);await assert.rejects(validateWorkspace(alias),error=>error.code==='WORKSPACE_INVALID');
});

test('workspace status reads eight versions and summarizes dirty Git without returning file contents or paths',async t=>{
    const f=await fixture(t);await writeFile(path.join(f.root,'private-token-name.txt'),'NEVER_RETURN_FILE_CONTENT');
    const value=await f.diagnostics.workspaceStatus();assert.equal(value.packages.length,8);assert.ok(value.packages.every(item=>item.version==='0.10.1'));
    assert.equal(value.git.head,f.head);assert.equal(value.git.branch,'main');assert.equal(value.git.dirty.untracked,1);
    assert.equal(JSON.stringify(value).includes('private-token-name'),false);assert.equal(JSON.stringify(value).includes('NEVER_RETURN'),false);
    assert.ok(value.checkCommands.includes('npm run check'));assert.equal(value.node,process.version);
});

test('workspace status explains unavailable Git in the MCP environment without disclosing raw errors',async t=>{
    const f=await fixture(t);
    const entry=`import {createDiagnostics} from ${JSON.stringify(new URL('../dev-mcp/diagnostics.mjs',import.meta.url).href)};
        console.log(JSON.stringify((await (await createDiagnostics(process.cwd())).workspaceStatus()).git));`;
    const missing=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',entry],{
        cwd:f.root,encoding:'utf8',env:{PATH:f.parent},timeout:10000,
    }));
    assert.equal(missing.available,false);assert.match(missing.reason,/executable.*unavailable/i);
    for(const [properties,expected]of [
        [{code:'EACCES'},/permission/i],
        [{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'},/output.*limit/i],
        [{code:'ETIMEDOUT'},/time.*limit/i],
        [{code:null,killed:true,signal:'SIGTERM'},/time.*limit/i],
    ]){
        const script=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
            cp.execFile=(...args)=>args.at(-1)(Object.assign(Error('PRIVATE_GIT_ERROR '+process.cwd()),${JSON.stringify(properties)}));
            syncBuiltinESMExports();const {createDiagnostics}=await import(${JSON.stringify(new URL('../dev-mcp/diagnostics.mjs',import.meta.url).href)});
            console.log(JSON.stringify((await (await createDiagnostics(process.cwd())).workspaceStatus()).git));`;
        const result=execFileSync(process.execPath,['--input-type=module','--eval',script],{cwd:f.root,encoding:'utf8',timeout:10000});
        const value=JSON.parse(result);assert.equal(value.available,false);assert.match(value.reason,expected);
        assert.doesNotMatch(result,/PRIVATE_GIT_ERROR/);assert.equal(result.includes(f.root),false);
    }
});

test('causal common log credentials are redacted while ordinary UUIDs remain useful',()=>{
    const secrets=['plain-secret','upper-secret','json-secret','sk-live-1234567890abcdefghij','ghp_1234567890abcdefghijklmnopqrstuvwxyz','github_pat_1234567890_abcdefghijklmnop'];
    const uuid='8c517be2-90f7-4a9a-b34c-ef425835942b';
    const text=redactLog('token=plain-secret\nTOKEN=upper-secret\n{"token":"json-secret"}\n'+secrets.slice(3).join('\n')+'\njob='+uuid);
    for(const secret of secrets)assert.ok(!text.includes(secret),secret+' must be redacted');assert.ok(text.includes(uuid));
});

test('log redaction handles headers, JSON cookies, URL credentials, PEM blocks and ANSI',()=>{
    const text=redactLog('\x1b[31mAuthorization: Bearer header-secret\x1b[0m\n{"cookie":"session=cookie-secret"}\n'+
        'https://user:url-password@example.test/a?token=query-secret#fragment-secret\n'+
        '-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_BODY\n-----END RSA PRIVATE KEY-----\napi_key=key-secret\n');
    for(const value of ['header-secret','cookie-secret','url-password','query-secret','fragment-secret','PRIVATE_BODY','key-secret','\x1b'])assert.ok(!text.includes(value),value);
});

test('log tail is bounded to requested lines and32KiB and marks evidence untrusted',async t=>{
    const f=await fixture(t);await writeFile(path.join(f.root,'.run/logs/neurocenter-catalog.log'),'old\n'.repeat(20000)+'last-one\nlast-two\n');
    const value=await f.diagnostics.serviceLogs('catalog',2);assert.equal(value.text,'last-one\nlast-two');assert.equal(value.lines,2);assert.equal(value.truncated,true);
    assert.ok(Buffer.byteLength(value.text)<=32768);assert.match(value.evidence,/Untrusted/);
    await assert.rejects(f.diagnostics.serviceLogs('../../secret'),error=>error.code==='INVALID_ARGUMENT');
    await assert.rejects(f.diagnostics.serviceLogs('catalog',101),error=>error.code==='INVALID_ARGUMENT');
});

test('causal hardlinked log alias cannot expose another owned fixture private file',async t=>{
    const f=await fixture(t),outside=path.join(f.parent,'private-sentinel');await writeFile(outside,'DO_NOT_DISCLOSE_PRIVATE_FILE');
    await link(outside,path.join(f.root,'.run/logs/neurocenter-catalog.log'));
    await assert.rejects(f.diagnostics.serviceLogs('catalog'),error=>error.code==='UNSAFE_FILE');assert.equal(await readFile(outside,'utf8'),'DO_NOT_DISCLOSE_PRIVATE_FILE');
});

test('safe reads reject link ancestors, link files, traversal, oversized reports and nonregular files',async t=>{
    const f=await fixture(t),outside=path.join(f.parent,'outside');await mkdir(outside);await writeFile(path.join(outside,'neurocenter-catalog.log'),'SECRET');
    await rm(path.join(f.root,'.run/logs'),{recursive:true});await symlink(outside,path.join(f.root,'.run/logs'));
    await assert.rejects(f.diagnostics.serviceLogs('catalog'),error=>error.code==='UNSAFE_FILE');
    await assert.rejects(readOwnedFile(f.root,'../outside/neurocenter-catalog.log',{limit:100}),error=>error.code==='UNSAFE_FILE');
    await assert.rejects(readOwnedFile(f.root,'.run/coverage',{limit:100}),error=>error.code==='UNSAFE_FILE');
    await rm(path.join(f.root,'.run/logs'));await mkdir(path.join(f.root,'.run/logs'));await symlink(path.join(outside,'neurocenter-catalog.log'),path.join(f.root,'.run/logs/neurocenter-catalog.log'));
    await assert.rejects(f.diagnostics.serviceLogs('catalog'),error=>error.code==='UNSAFE_FILE');
    await writeFile(path.join(f.root,f.reportPath),Buffer.alloc(16*1024**2+1));await assert.rejects(f.diagnostics.verificationSummary(f.reportPath),error=>error.code==='FILE_TOO_LARGE');
});

test('verification returns approved counters and denominator but no commands, secrets or source inventory',async t=>{
    const f=await fixture(t);f.report.sourceInventory={files:[{path:'secret-location',content:'hidden-secret'}]};f.report.packages[0].command=['SECRET_COMMAND'];await f.saveReport(f.report);
    const value=await f.diagnostics.verificationSummary(f.reportPath);assert.equal(value.status,'requested-suites-complete');assert.equal(value.source.status,'clean-head-match');
    assert.equal(value.summary.lines.pct,80);assert.equal(value.denominator.allWorkspaceSourcesIncluded,false);
    for(const secret of ['secret-location','hidden-secret','SECRET_COMMAND'])assert.ok(!JSON.stringify(value).includes(secret));
});

test('causal contradictory report percentages cannot turn covered80/100 into100percent',async t=>{
    const f=await fixture(t);f.report.summary.lines.pct=100;await f.saveReport(f.report);
    let value;try{value=await f.diagnostics.verificationSummary(f.reportPath);}catch(error){assert.equal(error.code,'MALFORMED_REPORT');return;}
    assert.equal(value.summary.lines.pct,80);
});

test('causal complete flag cannot hide skipped, cancelled or unknown test counters',async t=>{
    const f=await fixture(t);
    for(const change of [r=>{r.packages[0].skipped=1;},r=>{r.native={passed:1,failed:0,skipped:0,cancelled:1,exitCode:0};},r=>{r.packages[0].failed=null;},r=>{r.packages[0].testFileInventory={complete:false};}]){
        const report=structuredClone(f.report);change(report);await f.saveReport(report);
        let value;try{value=await f.diagnostics.verificationSummary(f.reportPath);}catch(error){assert.equal(error.code,'MALFORMED_REPORT');continue;}
        assert.notEqual(value.status,'requested-suites-complete');assert.equal(value.complete,false);
    }
});

test('verification marks in-progress, failed, mixed instrumentation and changed sources honestly',async t=>{
    const f=await fixture(t);const pending=structuredClone(f.report);delete pending.finishedAt;delete pending.summary;pending.packages=[];await f.saveReport(pending);
    const progress=await f.diagnostics.verificationSummary(f.reportPath);assert.equal(progress.status,'in-progress');assert.equal(progress.complete,false);
    const failed=structuredClone(f.report);failed.packages[0].failed=1;failed.packages[0].exitCode=1;await f.saveReport(failed);assert.equal((await f.diagnostics.verificationSummary(f.reportPath)).status,'failed');
    const mixed=structuredClone(f.report);mixed.comparablePercentages=false;mixed.coverageKind='experimental-mixed-instrumentation';mixed.sourceChangedDuringRun=true;await f.saveReport(mixed);
    const value=await f.diagnostics.verificationSummary(f.reportPath);assert.equal(value.summary.lines.pct,null);assert.equal(value.source.status,'changed');
    await f.saveReport(f.report);await writeFile(path.join(f.root,'changed.txt'),'changed');assert.equal((await f.diagnostics.verificationSummary(f.reportPath)).source.status,'not-fully-verified');
    for(const report of ['.run/coverage/../manifest.json','.env','/tmp/manifest.json','.run/coverage/a/b/manifest.json'])await assert.rejects(f.diagnostics.verificationSummary(report),error=>error.code==='INVALID_ARGUMENT');
    await writeFile(path.join(f.root,f.reportPath),'{');await assert.rejects(f.diagnostics.verificationSummary(f.reportPath),error=>error.code==='MALFORMED_REPORT');
});

test('causal standard mixed merge accepts summarynull without claiming comparable percentages',async t=>{
    const f=await fixture(t),report={...f.report,profile:'retained-runs-merge',coverageKind:'experimental-mixed-instrumentation',comparablePercentages:false,
        summary:null,experimentalSummary:f.report.summary,inputs:[{sourceBefore:f.report.sourceBefore,sourceAfter:f.report.sourceAfter}],sourceChangedDuringRun:true};
    delete report.sourceBefore;delete report.sourceAfter;
    await f.saveReport(report);const value=await f.diagnostics.verificationSummary(f.reportPath);
    assert.equal(value.comparablePercentages,false);assert.equal(value.summary.lines.pct,null);assert.equal(value.summary.lines.covered,80);assert.equal(value.source.status,'changed');
    assert.match(value.countScope,/overlap/);
});

async function localHttp(t,handler){
    const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return {server,port:server.address().port};
}

test('fixed health definitions follow actual dev ports and reject destinations in definitions',()=>{
    assert.deepEqual(services.map(item=>[item.name,item.port]),[['bridge',22222],['catalog',4100],['flags',4400],['skills',4200],['rag',4300],['gateway',4000],['frontend',5173]]);
    assert.throws(()=>healthReader([{name:'catalog',port:1,path:'http://foreign.test'}]));assert.throws(()=>healthReader([{name:'foreign',port:1,path:'/health'}]));
});

test('health does not return raw body, follow redirects or exceed its body/time budget',async t=>{
    const target=await localHttp(t,(request,response)=>{if(request.url==='/redirect'){response.writeHead(302,{location:'/DO_NOT_FOLLOW'}).end();}else if(request.url==='/large')response.end(Buffer.alloc(65536,65));else if(request.url==='/hang'){}else response.end('RAW_PRIVATE_HEALTH_BODY');});
    for(const [route,state]of [['/health','http-ok'],['/redirect','redirect-blocked'],['/large','body-limit'],['/hang','timeout']]){
        const value=await healthReader([{name:'catalog',port:target.port,path:route}])();assert.equal(value.services[0].state,state);assert.ok(!JSON.stringify(value).includes('RAW_PRIVATE'));
        assert.ok(value.services[0].bodyBytes<=32768);
    }
});

test('readiness distinguishes JSON okfalse, HTML200, wrong CSS type and large valid compiled CSS',async t=>{
    const target=await localHttp(t,(request,response)=>{
        if(request.url==='/ok')response.end('{"ok":true,"secret":"NEVER_RETURN"}');
        else if(request.url==='/false')response.end('{"ok":false}');
        else if(request.url==='/css')response.writeHead(200,{'content-type':'text/css; charset=utf-8'}).end('.ant-card { color: red; }'.repeat(10000));
        else response.writeHead(200,{'content-type':'text/html'}).end('<html>not ready</html>');
    });
    for(const [name,route,ready]of [['catalog','/ok',true],['catalog','/false',false],['catalog','/html',false],['frontend','/wrong',false],['frontend','/css',true]]){
        const value=await healthReader([{name,port:target.port,path:route,readinessPath:route}])();assert.equal(value.services[0].ready,ready);assert.equal(value.services[0].state,'http-ok');
        assert.ok(!JSON.stringify(value).includes('NEVER_RETURN'));if(name==='frontend')assert.equal(value.services[0].partialProbe,true);
    }
});

async function sdkFixture(t,definitions=[],fixtureEnvironment={}){
    const f=await fixture(t),entry=path.join(f.parent,'stdio entry with spaces.mjs');
    await writeFile(entry,`import {startDevMcp} from ${JSON.stringify(serverUrl)};await startDevMcp({workspace:${JSON.stringify(f.root)},services:${JSON.stringify(definitions)}});`);
    const transport=new StdioClientTransport({command:process.execPath,args:[entry],cwd:f.parent,env:{PATH:process.env.PATH,HOME:f.parent,USERPROFILE:f.parent,XDG_CONFIG_HOME:f.parent,...fixtureEnvironment},stderr:'pipe'});
    let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk;});
    const client=new Client({name:'owned-neurocenter-fixture',version:'1.0.0'});
    await client.connect(transport,{timeout:5000});t.after(async()=>{await client.close();assert.equal(stderr,'');});
    return {...f,client,transport};
}

test('actual SDK stdio lists the current readonly catalogue, calls it and returns safe input/file errors',async t=>{
    let requests=0;const target=await localHttp(t,(_request,response)=>{requests++;response.end('DO_NOT_RETURN_RAW_BODY');});
    let proxies=0;const proxy=await localHttp(t,(_request,response)=>{proxies++;response.writeHead(502).end();});
    const f=await sdkFixture(t,[{name:'catalog',port:target.port,path:'/health'}],{HTTP_PROXY:'http://127.0.0.1:'+proxy.port,HTTPS_PROXY:'http://127.0.0.1:'+proxy.port,NO_PROXY:'',NODE_USE_ENV_PROXY:'1'});assert.equal(requests,0);
    const list=await f.client.listTools();assert.deepEqual(list.tools.map(tool=>tool.name),expectedToolNames);assert.ok(list.tools.every(tool=>tool.annotations.readOnlyHint&&tool.annotations.idempotentHint&&!tool.annotations.destructiveHint&&!tool.annotations.openWorldHint));
    assert.ok(list.tools.every(tool=>tool.outputSchema?.type==='object'));
    const call=async(name,args={})=>(await f.client.callTool({name,arguments:args}));
    const status=await call('workspace_status');assert.equal(status.structuredContent.workspace,'neurocenter-workspace');
    assert.equal(status.structuredContent.developerTools.version,serverVersion);
    assert.deepEqual(status.structuredContent.developerTools.tools,expectedToolNames);
    const plan=await call('check_plan',{packages:['frontend'],steps:['test']});
    assert.deepEqual(plan.structuredContent.steps.map(step=>step.command),['npm run test']);
    await assert.rejects(readFile(path.join(f.root,'.run/check/report.json')),{code:'ENOENT'});
    const health=await call('services_health');assert.equal(health.structuredContent.services[0].state,'http-ok');assert.equal(requests,2);assert.equal(proxies,0);assert.ok(!JSON.stringify(health).includes('DO_NOT_RETURN'));
    assert.equal(health.structuredContent.services[0].ready,false);
    assert.ok(health.structuredContent.services[0].liveness);assert.ok(health.structuredContent.services[0].ownership);
    await writeFile(path.join(f.root,'.run/logs/neurocenter-catalog.log'),'token=SDK_SECRET\nready');const logs=await call('service_logs',{service:'catalog',lines:5});assert.ok(!JSON.stringify(logs).includes('SDK_SECRET'));
    const verification=await call('verification_summary',{report:f.reportPath});assert.equal(verification.structuredContent.packages[0].passed,10);
    await mkdir(path.join(f.root,'.run/check/sdk'),{recursive:true});
    const checkReport={schemaVersion:2,selection:{packages:['frontend'],steps:['typecheck']},plannedSteps:['frontend: typecheck'],state:'passed',success:true,
        startedAt:'2026-10-23T00:00:00Z',finishedAt:'2026-10-23T00:01:00Z',steps:[{name:'frontend: typecheck',ok:true,exitCode:0,signal:null,durationMs:10}],secret:'DO_NOT_RETURN_CHECK_SECRET'};
    await writeFile(path.join(f.root,'.run/check/sdk/report.json'),JSON.stringify(checkReport));
    const check=await call('verification_summary',{report:'.run/check/sdk/report.json'});
    assert.equal(check.structuredContent.status,'requested-steps-complete');assert.equal(check.structuredContent.source.status,'unknown');
    assert.ok(!JSON.stringify(check).includes('DO_NOT_RETURN_CHECK_SECRET'));
    await mkdir(path.join(f.root,'.run/isolated-build/sdk'),{recursive:true});
    await writeFile(path.join(f.root,'.run/isolated-build/sdk/receipt.json'),JSON.stringify({schemaVersion:1,ok:false,status:'preparing',
        selectedPackages:['frontend'],builds:[],inputs:null,startedAt:'2026-10-23T00:00:00Z'}));
    const build=await call('verification_summary',{report:'.run/isolated-build/sdk/receipt.json'});
    assert.equal(build.structuredContent.kind,'isolated-build');assert.equal(build.structuredContent.status,'in-progress');
    const catalog=await call('evidence_catalog',{limit:20});
    assert.equal(catalog.isError,undefined);
    assert.deepEqual(new Set(catalog.structuredContent.entries.filter(row=>row.state==='available').map(row=>row.family)),new Set(['check','coverage','isolated-build']));
    assert.ok(!JSON.stringify(catalog).includes('DO_NOT_RETURN_CHECK_SECRET'));
    const compared=await call('verify_source',{report:f.reportPath,expectedReportSha256:verification.structuredContent.reportSha256});
    assert.equal(compared.structuredContent.comparison.state,'unknown');
    assert.equal(compared.structuredContent.comparison.reason,'UNSUPPORTED_SOURCE_PROTOCOL');
    const trace=await call('request_trace',{flow:'tool-build',request:'11111111-1111-4111-8111-111111111111'});
    assert.equal(trace.structuredContent.state,'unavailable');assert.deepEqual(trace.structuredContent.events,[]);
    const metrics=Object.fromEntries(['lines','statements','functions','branches'].map(name=>[name,{total:2,covered:1}]));
    f.report.sourceInventory={files:[{path:'services/catalog-service/src/example.ts',role:'production',measurement:'represented'}]};await f.saveReport(f.report);
    await writeFile(path.join(f.root,'.run/coverage/final/gaps.json'),JSON.stringify({schemaVersion:1,profile:f.report.profile,coverageKind:f.report.coverageKind,
        comparablePercentages:true,complete:true,sourceChangedDuringRun:false,gaps:[{file:'services/catalog-service/src/example.ts',summary:metrics,
            uncoveredBranches:1,uncoveredFunctions:[{name:'recover',line:7}],uncoveredStatementLines:[7]}]}));
    const gaps=await call('coverage_gaps',{report:f.reportPath,package:'catalog-service'});
    assert.equal(gaps.structuredContent.totalTargets,1);assert.equal(gaps.structuredContent.targets[0].uncoveredFunctions[0].name,'recover');
    assert.equal(gaps.structuredContent.source.status,'clean-head-match');assert.match(gaps.structuredContent.reportSha256,/^[a-f0-9]{64}$/);
    assert.equal((await call('coverage_gaps',{report:f.reportPath,package:'catalog-service',limit:21})).isError,true);
    for(const [name,args]of [['services_health',{url:'http://secret:token@example.test'}],['service_logs',{service:'../../private-secret'}],['verification_summary',{report:'.env'}],
        ['check_plan',{packages:['frontend'],command:'SECRET_COMMAND'}],['check_plan',{packages:['../../private-secret']}],['check_plan',{packages:[]}],['check_plan',{packages:['frontend','frontend']}],
        ['coverage_gaps',{report:'.run/check/sdk/report.json',package:'frontend'}],['evidence_catalog',{families:['../secret']}],
        ['evidence_catalog',{limit:21}],['verify_source',{report:f.reportPath,expectedReportSha256:'bad'}],
        ['request_trace',{flow:'tool-build',request:'../private-secret'}],['service_logs',{service:'catalog',launchId:'../private-secret'}]]){
        const result=await call(name,args);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('private-secret'));assert.ok(!JSON.stringify(result).includes('secret:token'));
    }
    assert.equal((await call('service_logs',{service:'rag'})).isError,true);
    await assert.rejects(call('unknown'));await assert.rejects(call('toString'));assert.equal((await call('workspace_status')).isError,undefined);
});

test('actual SDK source comparison separates a recorded result from current fingerprint match and later edits',async t=>{
    const f=await sdkFixture(t),before=await captureCheckSource(f.root),report='.run/check/source/report.json';
    assert.ok(before.snapshot);
    await mkdir(path.dirname(path.join(f.root,report)),{recursive:true});
    await writeFile(path.join(f.root,report),JSON.stringify({schemaVersion:3,selection:{packages:['frontend'],steps:['typecheck']},
        plannedSteps:['frontend: typecheck'],state:'passed',success:true,startedAt:'2026-10-23T00:00:00.000Z',finishedAt:'2026-10-23T00:01:00.000Z',
        failure:null,cancellation:null,source:checkSourceResult(before,before),
        steps:[{name:'frontend: typecheck',ok:true,exitCode:0,signal:null,durationMs:1,leaderReaped:true,cleanup:{noLiveDescendants:true,signals:[],zombieCount:0}}]}));
    const summary=(await f.client.callTool({name:'verification_summary',arguments:{report}})).structuredContent;
    const selection={report,expectedReportSha256:summary.reportSha256};
    const matched=(await f.client.callTool({name:'verify_source',arguments:selection})).structuredContent;
    assert.equal(matched.recorded.complete,true);assert.equal(matched.comparison.state,'match');
    await writeFile(path.join(f.root,'new-untracked-source.ts'),'export const changed=true;');
    const changed=(await f.client.callTool({name:'verify_source',arguments:selection})).structuredContent;
    assert.equal(changed.recorded.complete,true);assert.equal(changed.comparison.state,'mismatch');
});

test('actual SDK impact plan scopes a known frontend change without executing its checks',async t=>{
    const f=await sdkFixture(t);
    await mkdir(path.join(f.root,'frontend/src'),{recursive:true});
    await writeFile(path.join(f.root,'frontend/src/example.ts'),'export const change=true;');
    const result=await f.client.callTool({name:'impact_plan',arguments:{baseRevision:f.head}});
    assert.equal(result.isError,undefined);assert.equal(result.structuredContent.mode,'scoped');
    assert.deepEqual(result.structuredContent.packages,['frontend']);assert.equal(result.structuredContent.sourceFingerprint.status,'known');
    assert.ok(result.structuredContent.plannedChecks.checks.length>0);
    await assert.rejects(readFile(path.join(f.root,'.run/check/report.json')),{code:'ENOENT'});
    const invalid=await f.client.callTool({name:'impact_plan',arguments:{baseRevision:'0'.repeat(40)}});
    assert.equal(invalid.isError,true);assert.match(JSON.stringify(invalid),/IMPACT_INVALID_BASE/);
});

test('actual SDK reads emitted request events from an owned launch and retained history after stop',async t=>{
    const f=await launchFixture(t),request='11111111-1111-4111-8111-111111111111',buildId='22222222-2222-4222-8222-222222222222';
    await writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'neurocenter-workspace'}));
    await writeFile(f.entry,`const {traceToolBuild}=require(${JSON.stringify(path.join(directory,'services/shared/dev-trace.cjs'))});
traceToolBuild('requested',{requestKey:${JSON.stringify(request)}});
traceToolBuild('accepted',{requestKey:${JSON.stringify(request)},buildId:${JSON.stringify(buildId)}});
setInterval(()=>{},1000);`);
    const launched=await f.launch({environment:{NEUROCENTER_DEV_TRACES:'1'}}),entry=path.join(f.root,'sdk-entry.mjs');
    await writeFile(entry,`import {startDevMcp} from ${JSON.stringify(serverUrl)};await startDevMcp({workspace:${JSON.stringify(f.root)},services:[]});`);
    const transport=new StdioClientTransport({command:process.execPath,args:[entry],cwd:f.root,
        env:{PATH:process.env.PATH,HOME:f.root,USERPROFILE:f.root,XDG_CONFIG_HOME:f.root},stderr:'pipe'});
    let stderr='';transport.stderr.on('data',chunk=>{stderr+=chunk;});
    const client=new Client({name:'owned-launch-trace-fixture',version:'1.0.0'});
    try{
        await client.connect(transport,{timeout:5000});
        const observed=(await client.callTool({name:'request_trace',arguments:{flow:'tool-build',request}})).structuredContent;
        assert.equal(observed.state,'observed');assert.equal(observed.currentProcessCorrelation.state,'owned');
        assert.deepEqual(observed.events.map(event=>event.event),['requested','accepted']);assert.equal(Object.hasOwn(observed,'complete'),false);
        const selected=(await client.callTool({name:'service_logs',arguments:{service:'catalog',launchId:launched.record.launchId}})).structuredContent;
        assert.equal(selected.details.launch.launchId,launched.record.launchId);assert.equal(selected.details.currentProcessCorrelation.state,'historical');
        await stopWatchGroup(launched.record);
        const history=(await client.callTool({name:'request_trace',arguments:{flow:'tool-build',request,launchId:launched.record.launchId}})).structuredContent;
        assert.equal(history.currentProcessCorrelation.state,'historical');assert.equal(history.events.length,2);
        assert.equal(stderr,'');
    }finally{await client.close();}
});

test('output-schema flag removes advertised schemas while calls retain their bounded response',async t=>{
    const f=await sdkFixture(t,[],{NEUROCENTER_DEV_MCP_OUTPUT_SCHEMAS:'0'}),list=await f.client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name),expectedToolNames);assert.ok(list.tools.every(tool=>!tool.outputSchema));
    const result=await f.client.callTool({name:'workspace_status',arguments:{}});
    assert.equal(result.structuredContent.workspace,'neurocenter-workspace');
    assert.equal(result.structuredContent.developerTools.version,serverVersion);
});

test('disabled service-details flag keeps liveness but sends no readiness probe',async t=>{
    const paths=[];const target=await localHttp(t,(request,response)=>{paths.push(request.url);response.end('{"ok":true}');});
    const f=await sdkFixture(t,[{name:'catalog',port:target.port,path:'/health'}],{NEUROCENTER_DEV_MCP_SERVICE_DETAILS:'0'});
    const result=await f.client.callTool({name:'services_health',arguments:{}}),service=result.structuredContent.services[0];
    assert.deepEqual(paths,['/health']);assert.equal(service.liveness.ok,true);assert.equal(service.ready,null);
    assert.equal(service.readiness.state,'skipped');assert.equal(service.ownership.state,'disabled');
});

test('disabled check-plan flag hides and rejects the tool while retained evidence stays readable',async t=>{
    const f=await sdkFixture(t,[],{NEUROCENTER_DEV_MCP_CHECK_PLAN:'0'}),list=await f.client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name),expectedToolNames.filter(name=>name!=='check_plan'));
    await assert.rejects(f.client.callTool({name:'check_plan',arguments:{packages:['frontend']}}));
    const report=await f.client.callTool({name:'verification_summary',arguments:{report:f.reportPath}});
    assert.equal(report.structuredContent.status,'requested-suites-complete');
});

test('disabled evidence flag hides new observations while retained verification summaries remain readable',async t=>{
    const f=await sdkFixture(t,[],{NEUROCENTER_DEV_MCP_EVIDENCE:'0'}),list=await f.client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name),expectedToolNames.filter(name=>!['evidence_catalog','verify_source'].includes(name)));
    for(const name of ['evidence_catalog','verify_source'])await assert.rejects(f.client.callTool({name,arguments:{}}));
    assert.equal((await f.client.callTool({name:'verification_summary',arguments:{report:f.reportPath}})).structuredContent.status,'requested-suites-complete');
});

test('disabled impact flag hides new planning while retained verification summaries remain readable',async t=>{
    const f=await sdkFixture(t,[],{NEUROCENTER_IMPACT_PLAN:'0'}),list=await f.client.listTools();
    assert.deepEqual(list.tools.map(tool=>tool.name),expectedToolNames.filter(name=>name!=='impact_plan'));
    await assert.rejects(f.client.callTool({name:'impact_plan',arguments:{baseRevision:f.head}}));
    assert.equal((await f.client.callTool({name:'verification_summary',arguments:{report:f.reportPath}})).structuredContent.status,'requested-suites-complete');
});

test('actual SDK request cancellation closes the owned health socket and keeps stdio usable',async t=>{
    const entered=deferred(),closed=deferred();const target=await localHttp(t,(request,_response)=>{entered.resolve();request.once('close',closed.resolve);});
    const f=await sdkFixture(t,[{name:'catalog',port:target.port,path:'/hang'}]);const controller=new AbortController();
    const pending=f.client.callTool({name:'services_health',arguments:{}},undefined,{signal:controller.signal,timeout:5000});pending.catch(()=>{});
    await bounded(entered.promise);controller.abort();await assert.rejects(pending);await bounded(closed.promise);
    assert.equal((await f.client.callTool({name:'workspace_status',arguments:{}})).isError,undefined);
});

for(const ending of ['eof','sigterm'])test('actual SDK server '+ending+' aborts pending health and exits without forced client cleanup',async t=>{
    const entered=deferred(),closed=deferred();const target=await localHttp(t,(request,_response)=>{entered.resolve();request.once('close',closed.resolve);});
    const f=await sdkFixture(t,[{name:'catalog',port:target.port,path:'/hang'}]);
    const pending=f.client.callTool({name:'services_health',arguments:{}},undefined,{timeout:5000});pending.catch(()=>{});await bounded(entered.promise);
    // Pin this acceptance to SDK1.32.1's owned subprocess; close() is deliberately not called until after exit.
    const child=f.transport._process,exited=once(child,'exit');
    if(ending==='eof')child.stdin.end();else child.kill('SIGTERM');
    const [code,signal]=await bounded(exited,1000);assert.equal(code,0);assert.equal(signal,null);await bounded(closed.promise);await assert.rejects(pending);
});
