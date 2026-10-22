import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,afterAll,describe,expect,it} from 'vitest';
import {bridgeCliProfileFixture,profileCleanup,profileToken,profileSite} from './bridge-cli-profile.fixture.js';

const fixtures:Array<Awaited<ReturnType<typeof bridgeCliProfileFixture>>>=[];
afterEach(async()=>{for(const fixture of fixtures.splice(0))await fixture.close();});
afterAll(async()=>{
    if(process.env.BRIDGE_CLI_PROFILE_TEST_CLEANUP)await fs.writeFile(process.env.BRIDGE_CLI_PROFILE_TEST_CLEANUP,JSON.stringify(profileCleanup,null,2)+'\n',{flag:'wx',mode:0o600});
});
async function fixture(kind:'http'|'https'|'proxy'='http'){const value=await bridgeCliProfileFixture(kind);fixtures.push(value);return value;}
describe('Standalone connect uses the installed OpenCode runtime profile',()=>{
    it('reuses saved HOME credentials without creating a fresh pair from caller HOME',async()=>{
        const f=await fixture(),before=await fs.readFile(f.config,'utf8'),marker=await fs.readFile(f.settings,'utf8');
        const result=await f.run();expect(result.code,result.stderr).toBe(0);
        expect(result.stdout).toContain('Существующее подключение сохранено');
        expect(f.requests.map(request=>request.route)).toEqual(['/api/device-channel/identity']);
        expect(f.requests[0]!.authorization).toBe('Bearer '+profileToken);
        expect(await f.workers()).toMatchObject([{home:f.runtimeHome}]);
        expect(await fs.readFile(f.config,'utf8')).toBe(before);expect(await fs.readFile(f.settings,'utf8')).toBe(marker);
        expect(JSON.parse(await fs.readFile(f.credentials,'utf8')).token).toBe(profileToken);
    });
    it('loads saved extra CA before Node starts its first actual HTTPS request',async()=>{
        const f=await fixture('https'),result=await f.run(['connect','--open'],{HOME:f.runtimeHome,USERPROFILE:f.runtimeHome});expect(result.code,result.stderr).toBe(0);
        expect(f.requests.map(request=>request.route)).toEqual(['/api/device-channel/identity']);
        expect(result.stdout).toContain('Существующее подключение сохранено');
    });
    it('loads saved Node proxy opt-in before the first actual request to a loopback-only proxy',async()=>{
        const f=await fixture('proxy'),result=await f.run(['connect','--open'],{HOME:f.runtimeHome,USERPROFILE:f.runtimeHome});expect(result.code,result.stderr).toBe(0);
        expect(f.proxyTunnels).toEqual([new URL(f.api).host]);
        expect(f.requests.map(request=>request.route)).toEqual(['/api/device-channel/identity']);
        expect(f.directRequests).toEqual([]);
        expect(result.stdout).toContain('Существующее подключение сохранено');
    });
    it.each(['missing','unregistered'])('keeps fresh caller-profile connect working when the saved bridge profile is %s',async mode=>{
        const f=await fixture();
        if(mode==='missing')await fs.rm(f.config);
        else await fs.writeFile(f.config,JSON.stringify({mcp:{'other-agent':f.configuration.mcp['other-agent']}}));
        await fs.mkdir(path.dirname(f.callerCredentials),{recursive:true});await fs.copyFile(f.credentials,f.callerCredentials);
        const result=await f.run();expect(result.code,result.stderr).toBe(0);
        expect(f.requests.map(request=>request.route)).toEqual(['/api/device-channel/identity']);
        expect(await f.workers()).toMatchObject([{home:f.callerHome}]);
    });
    it('help and version stay available without parsing or selecting a runtime profile',async()=>{
        const f=await fixture();await fs.writeFile(f.config,'broken JSON');
        expect((await f.run(['--help'])).code).toBe(0);expect((await f.run(['--version'])).code).toBe(0);
        expect(f.requests).toEqual([]);expect(await f.workers()).toEqual([]);
    });
    it('registers the short command in caller HOME without moving management into saved runtime HOME',async()=>{
        const f=await fixture(),before=await fs.readFile(f.config,'utf8');
        const result=await f.run(['--install-command'],{NEUROCENTER_URL:profileSite,NEUROCENTER_API_URL:f.api});
        expect(result.code,result.stderr).toBe(0);expect(await fs.readFile(path.join(f.callerHome,'.local/bin/neurocenter-bridge'),'utf8')).toContain('Neurocenter bridge command v1');
        expect(await fs.access(path.join(f.runtimeHome,'.local/bin/neurocenter-bridge')).then(()=>true,()=>false)).toBe(false);
        expect(await fs.readFile(f.config,'utf8')).toBe(before);expect(f.requests).toEqual([]);
    });
    it.each(['command','site','api','environment','empty-home','duplicate'])('refuses an ambiguous or incompatible saved %s before any API request',async kind=>{
        const f=await fixture();
        if(kind==='command')f.own.command[1]=path.join(f.root,'foreign/index.js');
        if(kind==='site')f.savedEnvironment.NEUROCENTER_URL='https://foreign.example.test';
        if(kind==='api')f.savedEnvironment.NEUROCENTER_API_URL='https://foreign.example.test';
        if(kind==='environment')(f.savedEnvironment as Record<string,unknown>).PRIVATE_SETTING={secret:'must-not-print'};
        if(kind==='empty-home')f.savedEnvironment.HOME='';
        const content=JSON.stringify(f.configuration);
        await fs.writeFile(f.config,kind==='duplicate'?content.replace('"enabled":false','"enabled":false,"enabled":true'):content);
        const before=await fs.readFile(f.config,'utf8'),result=await f.run();
        expect(result.code).toBe(1);expect(result.stderr).not.toMatch(/must-not-print|PRIVATE_SETTING/);
        expect(f.requests).toEqual([]);expect(await f.workers()).toEqual([]);expect(await fs.readFile(f.config,'utf8')).toBe(before);
    });
    it('preserves an explicit caller API override instead of replacing it with installation.json',async()=>{
        const f=await fixture(),before=await fs.readFile(f.settings,'utf8');
        const result=await f.run(['connect'],{NEUROCENTER_API_URL:'http://127.0.0.1:1'});
        expect(result.code).toBe(1);expect(f.requests).toEqual([]);expect(await fs.readFile(f.settings,'utf8')).toBe(before);
    });
});
