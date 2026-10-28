import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {captureNativeCliJson} from './native-cli-json.fixture.js';

describe('Native CLI regular-file JSON capture',()=>{
    let temporary:string,preserveTemporary=false;
    beforeEach(async()=>{preserveTemporary=false;temporary=await fs.mkdtemp(path.join(os.tmpdir(),'native-json-unit-'));});
    afterEach(async()=>{if(!preserveTemporary)await fs.rm(temporary,{recursive:true,force:true});});
    const env=()=>({HOME:temporary,USERPROFILE:temporary,PATH:path.dirname(process.execPath),TMPDIR:temporary});
    const execute=(script:string,signal?:AbortSignal)=>captureNativeCliJson(process.execPath,['--eval',script],{cwd:temporary,env:env(),temporary,signal})
        .catch(error=>{if(error.code==='NATIVE_CLI_OWNERSHIP_UNKNOWN')preserveTemporary=true;throw error;});
    const empty=async()=>expect(await fs.readdir(temporary)).toEqual([]);
    const gone=(pid:number)=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}};

    it('captures the exact full UTF-8 JSON above 64 KiB through immediate exit, including its final sentinel',async()=>{
        const phrase='Синтетическая инструкция для native metadata. ';
        const expected={prompt:phrase.repeat(4000),sentinel:'FULL_JSON_END'};
        const raw=JSON.stringify(expected)+'\n';expect(Buffer.byteLength(raw)).toBeGreaterThan(65536);
        const result=await execute(`require('node:fs').writeSync(2,${JSON.stringify('fixture stderr\n')});process.stdout.write(JSON.stringify({prompt:${JSON.stringify(phrase)}.repeat(4000),sentinel:'FULL_JSON_END'})+'\\n');process.exit(0);`);
        expect(result).toEqual({stdout:raw,stderr:'fixture stderr\n'});expect(JSON.parse(result.stdout)).toEqual(expected);await empty();
    });
    it('preserves the native nonzero exit, stdout and stderr instead of accepting valid-looking JSON',async()=>{
        await expect(execute("process.stdout.write('{\"not\":\"accepted\"}');process.stderr.write('fixture failure');process.exit(7);"))
            .rejects.toMatchObject({code:7,exitCode:7,signal:null,stdout:'{"not":"accepted"}',stderr:'fixture failure'});
        await empty();
    });
    it('rejects output beyond the unchanged 2 MiB budget rather than returning a valid prefix',async()=>{
        await expect(execute("require('node:fs').writeSync(1,Buffer.alloc(2*1024*1024+1,120));"))
            .rejects.toMatchObject({code:'NATIVE_CLI_OUTPUT_LIMIT'});
        await empty();
    });
    it('drains cancellation even when the owned leader exits before its TERM-ignoring descendant',async()=>{
        const controller=new AbortController(),marker=path.join(temporary,'ready.json'),descendantMarker=path.join(temporary,'descendant.json');
        const publish=(file:string,value:string)=>`require('node:fs').writeFileSync(${JSON.stringify(file+'.tmp')},${value});require('node:fs').renameSync(${JSON.stringify(file+'.tmp')},${JSON.stringify(file)});`;
        const descendant=`process.on('SIGTERM',()=>{});${publish(descendantMarker,'JSON.stringify({pid:process.pid})')}setInterval(()=>{},1000);`;
        const launch=process.platform==='win32'?'':`const descendant=require('node:child_process').spawn(process.execPath,['--eval',${JSON.stringify(descendant)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));`;
        const outcome=execute(`${launch}${publish(marker,'JSON.stringify({pid:process.pid})')}setInterval(()=>{},1000);`,controller.signal)
            .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
        let pid:number|undefined,descendantPid:number|undefined;
        try{
            const until=Date.now()+3000;
            while(Date.now()<until){
                try{pid=JSON.parse(await fs.readFile(marker,'utf8')).pid;if(process.platform!=='win32')descendantPid=JSON.parse(await fs.readFile(descendantMarker,'utf8')).pid;break;}
                catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,10));}
            }
            controller.abort();const result=await outcome;expect(result.error).toMatchObject({code:'ABORT_ERR'});expect(pid).toBeTypeOf('number');
            expect(gone(pid!)).toBe(true);if(process.platform!=='win32'){expect(descendantPid).toBeTypeOf('number');expect(gone(descendantPid!)).toBe(true);await fs.unlink(descendantMarker);}
            await fs.unlink(marker);await empty();
        }finally{controller.abort();await outcome;}
    });
});
