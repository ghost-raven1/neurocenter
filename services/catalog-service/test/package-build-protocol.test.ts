import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {BuildConfiguration} from '../src/package-build/package-build.model';

const mocks=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',async()=>({...await vi.importActual('node:child_process'),spawn:mocks.spawn}));
import {runPackageBuilder} from '../src/package-build/build-process';

const config:BuildConfiguration={kind:'plugin',name:'Protocol fixture',description:'Fixture',targets:['darwin-arm64'],tags:[],
    source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default()=>({})'}]}};
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});vi.clearAllMocks();});

/** Child output is untrusted; only an allowlisted machine code becomes a user-facing failure. */
async function fixture(stdout:string,code:number,stderr='',configuration=config){
    const stage=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-protocol-'));roots.push(stage);
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    mocks.spawn.mockImplementation(()=>{queueMicrotask(()=>{
        child.stdout.write(stdout.slice(0,17));child.stdout.end(stdout.slice(17));child.stderr.end(stderr);child.emit('close',code);
    });return child;});
    return {stage,run:(progress=vi.fn())=>runPackageBuilder(configuration,stage,vi.fn(),progress)};
}

describe('Builder progress and failure protocol',()=>{
    it('Maps the known resource error to a clear message without forwarding child content',async()=>{
        const f=await fixture(JSON.stringify({type:'build-error',code:'SOURCE_RESOURCE_UNSUPPORTED',message:'PRIVATE token https://private.invalid'})+'\n',1,'PRIVATE stderr');
        await expect(f.run()).rejects.toThrow('Исходники читают соседний runtime-ресурс, который не переносится при сборке JS/TS. Выберите готовый JavaScript npm-пакет; готовый MCP также можно добавить runtime-архивом с ресурсами.');
    });
    it('Unknown child errors and stderr remain private',async()=>{
        const f=await fixture(JSON.stringify({type:'build-error',code:'FOREIGN',message:'PRIVATE'})+'\n',1,'PRIVATE stderr');
        await expect(f.run()).rejects.toThrow('Сборка не выполнена. Проверьте npm-пакет, файл запуска и его зависимости.');
    });
    it.each([
        ['PYTHON_DEPENDENCIES_UNAVAILABLE', 'готовые wheel-пакеты из PyPI'],
        ['PYTHON_RUNTIME_UNAVAILABLE', 'Не удалось подготовить встроенный Python'],
        ['PYTHON_SOURCE_INVALID', 'Не удалось проверить исходники Python'],
    ])('Reports %s through a fixed message, keeping child output private',async(code,expected)=>{
        const f=await fixture(JSON.stringify({type:'build-error',code,message:'PRIVATE token /server/path'})+'\n',1,'PRIVATE stderr');
        try {await f.run();throw Error('Expected Python failure');}
        catch(error){expect((error as Error).message).toContain(expected);expect((error as Error).message).not.toMatch(/PRIVATE|server\/path/);}
    });
    it.each(['constructor','toString','__proto__'])('Does not treat inherited key %s as a trusted error',async code=>{
        const f=await fixture(JSON.stringify({type:'build-error',code})+'\n',1);
        await expect(f.run()).rejects.toThrow('Сборка не выполнена.');
    });
    it('Normal progress and successful completion still return the asset path',async()=>{
        const event={type:'build-progress',target:'darwin-arm64',completed:1,total:1};
        const f=await fixture(JSON.stringify(event)+'\n',0),progress=vi.fn().mockResolvedValue(undefined);
        await expect(f.run(progress)).resolves.toBe(path.join(f.stage,'output/asset.json'));
        expect(progress).toHaveBeenCalledExactlyOnceWith(event);
    });
    it('Publication CAS control never changes recipe/source identity or enters the builder declaration',async()=>{
        const first=await fixture('',0);await first.run();const old=JSON.parse(await fs.readFile(path.join(first.stage,'recipe.json'),'utf8'));
        const publication={catalogId:'ai-plug-11111111-1111-4111-8111-111111111111',kind:'plugin' as const,name:config.name,expectedVersion:2,expectedSourceHash:'a'.repeat(64),nativeHash:'b'.repeat(64),origins:[]};
        const second=await fixture('',0,'',{...config,publication});await second.run();
        expect(JSON.parse(await fs.readFile(path.join(second.stage,'recipe.json'),'utf8'))).toEqual(old);
    });
});
