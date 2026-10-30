import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {observeOpenCodeCli} from '../src/features/computer-setup/process.js';
import {findUserOpenCode,userOpenCodeDirectories} from '../src/features/computer-setup/executable.js';
import {computerSetupFixture} from './computer-setup.fixture.js';

describe('Fixed user CLI observation through actual owned native processes',()=>{
    let fixture:Awaited<ReturnType<typeof computerSetupFixture>>;
    beforeEach(async()=>{fixture=await computerSetupFixture();});
    afterEach(async()=>{try{await fixture.close();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});}});
    const signal=()=>new AbortController().signal;
    it('does not authorize, journal a wrapper or start a command for an already aborted request',async()=>{
        const controller=new AbortController();controller.abort();const authorize=vi.fn();
        await expect(observeOpenCodeCli(fixture.context,authorize,controller.signal)).rejects.toThrow();
        expect(authorize).not.toHaveBeenCalled();expect(fixture.receipt().process).toBeUndefined();
    });
    it.each(['deviceId','jobId'] as const)('rejects an uppercase %s before authorization, journaling or command execution',async field=>{
        const marker=path.join(fixture.temporary,'uppercase-command-executed');
        await fixture.writeCli(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log('1.14.48');`);
        const authorize=vi.fn(async()=>{}),context={...fixture.context,[field]:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'};
        const outcome=await observeOpenCodeCli(context,authorize,signal()).then(()=> 'unexpected observation',error=>(error as Error).message);
        const executed=await fs.stat(marker).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
        expect({outcome,authorizations:authorize.mock.calls.length,executed}).toEqual({outcome:'Некорректное задание проверки OpenCode.',authorizations:0,executed:false});
        expect(fixture.receipt().process).toBeUndefined();
    },20000);
    it('bounds hanging preflight authorization without inventing a timed-out observation',async()=>{
        const authorize=vi.fn(()=>new Promise<void>(()=>{}));
        await expect(observeOpenCodeCli(fixture.context,authorize,AbortSignal.timeout(30))).rejects.toThrow('не получила наблюдение');
        expect(authorize).toHaveBeenCalledOnce();expect(fixture.receipt().process).toBeUndefined();
    });
    it('bounds a hanging executable lookup before execution without inventing a checkedAt receipt',async()=>{
        const realpath=fs.realpath.bind(fs);
        vi.spyOn(fs,'realpath').mockImplementation(async file=>String(file)===fixture.executable?new Promise<string>(()=>{}):realpath(file));
        await expect(observeOpenCodeCli(fixture.context,async()=>{},AbortSignal.timeout(30))).rejects.toThrow('не получила наблюдение');
        expect(fixture.receipt().process).toBeUndefined();
    });
    it('observes only --version from the actual private user executable and closes it',async()=>{
        const args=path.join(fixture.temporary,'arguments.json');
        await fixture.writeCli(`require('node:fs').writeFileSync(${JSON.stringify(args)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));console.log('1.14.48');`);
        const result=await observeOpenCodeCli(fixture.context,async()=>{},signal());
        expect(result).toMatchObject({schemaVersion:1,scope:'global',deviceId:fixture.identity.deviceId,jobId:fixture.identity.id,status:'installed',version:'1.14.48'});
        expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
        expect(JSON.parse(await fs.readFile(args,'utf8'))).toEqual({args:['--version'],cwd:fixture.home});
        expect(JSON.parse(await fs.readFile(fixture.receipt().process!.receipt,'utf8')).closed).toBe(true);
    },20000);
    it('accepts an observed 2.2.2 CLI version without claiming integration or changing its bytes',async()=>{
        const args=path.join(fixture.temporary,'v2-arguments.json');
        await fixture.writeCli(`require('node:fs').writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));console.log('2.2.2');`);
        const before=await fs.readFile(fixture.executable),result=await observeOpenCodeCli(fixture.context,async()=>{},signal());
        expect(result).toMatchObject({status:'installed',version:'2.2.2'});expect(Object.keys(result).sort()).toEqual(['checkedAt','deviceId','jobId','schemaVersion','scope','status','version']);
        expect(JSON.parse(await fs.readFile(args,'utf8'))).toEqual(['--version']);expect(await fs.readFile(fixture.executable)).toEqual(before);
    },20000);
    it('canonicalizes the exact official OpenCode 2.2.2 version output',async()=>{
        await fixture.writeCli(`console.log('opencode v2.2.2');`);
        expect(await observeOpenCodeCli(fixture.context,async()=>{},signal())).toMatchObject({status:'installed',version:'2.2.2'});
    },20000);
    it.each([['1.14.48','2.2.2'],['2.2.2','1.14.48']])('with two user CLIs observes first PATH %s and never executes later %s',async(firstVersion,secondVersion)=>{
        const second=path.join(fixture.temporary,'second'),marker=path.join(fixture.temporary,'selected-command');await fs.mkdir(second);
        await fixture.writeCli(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'first');console.log(${JSON.stringify(firstVersion)});`);
        const secondFile=await fixture.writeCli(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'second');console.log(${JSON.stringify(secondVersion)});`,path.join(second,'opencode'));
        const before=[await fs.readFile(fixture.executable),await fs.readFile(secondFile)],search=[fixture.bin,second].join(path.delimiter);
        fixture.context.directories=[fixture.bin,second];fixture.context.environment.PATH=search;vi.stubEnv('PATH',search);
        expect(await observeOpenCodeCli(fixture.context,async()=>{},signal())).toMatchObject({status:'installed',version:firstVersion});
        expect(await fs.readFile(marker,'utf8')).toBe('first');expect(await fs.readFile(fixture.executable)).toEqual(before[0]);expect(await fs.readFile(secondFile)).toEqual(before[1]);
    },20000);
    it('ignores SDK and probe targets even when PATH opencode is a symlink',async()=>{
        const probe=await fixture.writeCli(`throw Error('a bundled probe must not execute');`,path.join(fixture.sdk,'opencode-probe'));
        await fs.symlink(probe,fixture.executable);
        expect(await observeOpenCodeCli(fixture.context,async()=>{},signal())).toMatchObject({status:'missing'});
        expect(fixture.receipt().process).toBeUndefined();
    });
    it.each([2,3])('rejects A to B symlink replacement at authorization barrier %i before permitting execution',async barrier=>{
        const marker=path.join(fixture.temporary,'executed'),a=await fixture.writeCli(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'A');console.log('1.0.0');`,path.join(fixture.temporary,'A'));
        const b=await fixture.writeCli(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'B');console.log('2.0.0');`,path.join(fixture.temporary,'B'));
        await fs.symlink(a,fixture.executable);let calls=0;
        await expect(observeOpenCodeCli(fixture.context,async()=>{if(++calls===barrier){await fs.unlink(fixture.executable);await fs.symlink(b,fixture.executable);}},signal())).rejects.toThrow('не получила наблюдение');
        await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});
    },20000);
    it('rejects a higher-priority command appearing during final authorization without returning the previous version',async()=>{
        const priority=path.join(fixture.temporary,'priority');await fs.mkdir(priority);fixture.context.directories=[priority,fixture.bin];
        await fixture.writeCli(`console.log('1.0.0');`);let calls=0;
        const result=await observeOpenCodeCli(fixture.context,async()=>{if(++calls===4)await fixture.writeCli(`console.log('2.0.0');`,path.join(priority,'opencode'));},signal());
        expect(result).toMatchObject({status:'failed'});expect(result).not.toHaveProperty('version');
    },20000);
    it.each([
        [`console.error('PRIVATE_STDERR_SECRET');console.log('1.2.3');`,'installed'],
        [`console.error('PRIVATE_STDERR_SECRET');console.log('1.2.3');process.exitCode=7;`,'failed'],
        [`process.stderr.write('PRIVATE_STDERR_SECRET'.repeat(10000));console.log('1.2.3');setInterval(()=>{},1000);`,'failed'],
        [`console.log('PRIVATE_INVALID_VERSION_SECRET');`,'failed'],
        [`console.log('unexpected opencode v2.2.2');`,'failed'],
        [`console.log('opencode v2.2.2\\nPRIVATE_BANNER');`,'failed'],
        [`console.log('\\u001b[32mopencode v2.2.2\\u001b[0m');`,'failed'],
        [`process.stdout.write('PRIVATE_OUTPUT_SECRET'.repeat(10000));setInterval(()=>{},1000);`,'failed'],
    ])('keeps stderr and unvalidated or overflowing output private: %s',async(code,status)=>{
        await fixture.writeCli(code);
        const result=await observeOpenCodeCli(fixture.context,async()=>{},signal());
        expect(result.status).toBe(status);expect(JSON.stringify(result)).not.toContain('PRIVATE_');
        if(status!=='installed')expect(result).not.toHaveProperty('version');
    },20000);
    it.each(['cancel','deadline'])('closes the actual hanging command and detached descendant on %s before resolving',async mode=>{
        const marker=path.join(fixture.temporary,'children.json'),controller=new AbortController();
        await fixture.writeCli(`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.once('spawn',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000);`);
        const running=observeOpenCodeCli(fixture.context,async()=>{},controller.signal);void running.catch(()=>{});
        await vi.waitFor(async()=>expect(await fs.readFile(marker,'utf8')).toMatch(/^\[/),{timeout:10000});
        const pids=JSON.parse(await fs.readFile(marker,'utf8')) as number[];
        controller.abort(mode==='deadline'?Object.assign(new Error('private fixture deadline'),{name:'TimeoutError'}):new Error('private fixture cancellation'));
        if(mode==='deadline')expect(await running).toMatchObject({status:'timed-out'});else await expect(running).rejects.toThrow('остановлена');
        for(const pid of pids)expect(()=>process.kill(pid,0)).toThrow();
        expect(JSON.parse(await fs.readFile(fixture.receipt().process!.receipt,'utf8')).closed).toBe(true);
    },20000);
    it('uses only absolute local PATH directories plus standard user locations',async()=>{
        expect(userOpenCodeDirectories(fixture.home,['relative','',fixture.bin].join(path.delimiter))).toEqual(expect.arrayContaining([fixture.bin,path.join(fixture.home,'.opencode','bin'),path.join(fixture.home,'.local','bin')]));
        expect(userOpenCodeDirectories(fixture.home,'relative')).not.toContain('relative');
        expect(await findUserOpenCode([fixture.bin],[fixture.sdk],signal())).toBeUndefined();
    });
});
