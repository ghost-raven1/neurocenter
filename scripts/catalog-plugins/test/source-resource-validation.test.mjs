import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPortableSourceResources} from '../source-resource-validation.mjs';
import {buildRecipe} from '../build.mjs';
import {readyManifest} from '../manifest.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import {compileNpmTypeScript} from '../source-adapters.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const buildCli=fileURLToPath(new URL('../build.mjs',import.meta.url));

const anchoredReads=[
    "import fs from 'node:fs/promises';fs.readFile(new URL('./prompt.txt',import.meta.url));",
    "import{readFile as load}from'fs/promises';const resource=new URL('./prompt.txt',import.meta.url);load(resource);",
    "import*as fs from'node:fs';fs.promises.readFile(new URL('./prompt.txt',import.meta.url));",
    "const{readFileSync:load}=require('node:fs');const path=require('node:path');load(path.join(__dirname,'prompt.txt'));",
    "const fs=require('fs');const path=require('path');fs.readFileSync(path.resolve(path.dirname(__filename),'prompt.txt'));",
    "const{promises:{readFile:load}}=require('fs');load(__dirname+'/prompt.txt');",
    "const fs=await import('node:fs/promises');fs.readFile(new URL('./prompt.txt',import.meta.url));",
    "import{createRequire}from'node:module';const localRequire=createRequire(import.meta.url);const fs=localRequire('node:fs');fs.readFileSync(new URL('./prompt.txt',import.meta.url));",
    "import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';const filename=fileURLToPath(import.meta.url);readFile(filename);",
    "import fs from'node:fs';fs.createReadStream(new URL('./template.bin',import.meta.url));",
    "import fs from'node:fs/promises';fs.open(new URL('./template.bin',import.meta.url),'r');",
    "import{readFile}from'node:fs/promises';interface Input{path:string};const location:URL=new URL('./prompt.txt',import.meta.url);readFile(location);",
];
for(const[sourceIndex,source]of anchoredReads.entries())test('Known module-relative filesystem read is rejected: '+sourceIndex,async()=>{
    await assert.rejects(assertPortableSourceResources(source,sourceIndex===anchoredReads.length-1?'index.ts':'index.mjs'),/читает ресурс.*готовый JavaScript npm-пакет; готовый MCP также можно добавить runtime-архивом/);
});

const portableSources=[
    "import{createRequire}from'node:module';const require=createRequire(import.meta.url);export default()=>require('node:path').basename('/tmp/plugin');",
    "import{fileURLToPath}from'node:url';if(process.argv[1]===fileURLToPath(import.meta.url))console.log('MAIN');",
    "const documentation=\"fs.readFile(new URL('./prompt.txt',import.meta.url))\";/*require('fs').readFileSync(__dirname+'/prompt')*/export default()=>documentation;",
    "import fs from'node:fs/promises';export default input=>fs.readFile(input.path);",
    "import fs from'node:fs/promises';export default()=>fs.readFile(new URL('file:///tmp/external.txt',import.meta.url));",
    "import fs from'node:fs/promises';export default()=>fs.readFile(new URL('/tmp/external.txt',import.meta.url));",
    "import fs from'node:fs/promises';export default fs=>fs.readFile(new URL('./prompt',import.meta.url));",
    "import{readFile}from'node:fs/promises';export default function(readFile){return readFile(new URL('./prompt',import.meta.url));}",
    "const fs=require('fs');export default function(__dirname){return fs.readFileSync(__dirname+'/project.txt');}",
    "function require(value){return{readFileSync:value=>value}};require('fs').readFileSync(__dirname+'/custom.txt');",
    "import fs from'node:fs/promises';fs.open(new URL('./generated.txt',import.meta.url),'w');",
    "import fs from'node:fs/promises';const base=import.meta.url;export default input=>{ {const base=input.path;var location=base;} return fs.readFile(location);};",
    "import fs from'node:fs/promises';export default input=>fs.readFile(input.__dirname);",
];
for(const[sourceIndex,source]of portableSources.entries())test('Portable source remains accepted without parsing comments or strings: '+sourceIndex,async()=>{
    await assertPortableSourceResources(source,'index.mjs');
});

const recipe={schemaVersion:1,key:'resource-plugin',name:'Resource plugin',kind:'plugin',revision:'1.0.0',description:'Module resource regression',
    source:{type:'project',directory:'source',entrypoint:'src/index.ts'},targets:['darwin-arm64']};
test('Nested module-relative resources fail before an installable project artifact is published',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-nested-resource-')));
    try{
        await fs.mkdir(path.join(root,'source/src/lib'),{recursive:true});
        await fs.writeFile(path.join(root,'source/src/index.ts'),"export{default}from'./lib/plugin';");
        await fs.writeFile(path.join(root,'source/src/lib/plugin.ts'),"import{readFile}from'node:fs/promises';export default async()=>({prompt:await readFile(new URL('./prompt.txt',import.meta.url),'utf8')});");
        await fs.writeFile(path.join(root,'source/src/lib/prompt.txt'),'RUNTIME_RESOURCE');
        const output=path.join(root,'output');
        const recipePath=path.join(root,'recipe.json');
        await fs.writeFile(recipePath,JSON.stringify(recipe));
        await assert.rejects(buildRecipe({recipe,recipePath,output}),error=>error.code==='SOURCE_RESOURCE_UNSUPPORTED'&&/src\/lib\/plugin.ts.*читает ресурс/.test(error.message));
        await assert.rejects(fs.stat(path.join(output,'asset.json')),{code:'ENOENT'});
        for(const progress of [true,false]){
            const cliOutput=path.join(root,progress?'cli-progress':'cli-plain');
            const result=spawnSync(process.execPath,[buildCli,'--recipe',recipePath,'--output',cliOutput,...(progress?['--progress']:[])],{encoding:'utf8',timeout:30_000,cwd:root});
            assert.equal(result.error,undefined);
            assert.equal(result.status,1);
            assert.match(result.stderr,/src\/lib\/plugin.ts.*читает ресурс.*готовый JavaScript npm-пакет; готовый MCP также можно добавить runtime-архивом/);
            if(progress){
                const events=result.stdout.trim().split('\n').map(line=>JSON.parse(line));
                const failures=events.filter(event=>event.type==='build-error');assert.equal(failures.length,1);
                assert.deepEqual({...failures[0],reason:undefined},{type:'build-error',schemaVersion:1,stage:'compile',target:'darwin-arm64',code:'SOURCE_RESOURCE_UNSUPPORTED',reason:undefined});
                assert.match(failures[0].reason,/src\/lib\/plugin.ts.*читает ресурс/);assert.ok(failures[0].reason.length<=1000);
                assert.equal(events.filter(event=>event.type==='build-progress').length,1);
                assert.ok(!result.stdout.includes(root));
            }else assert.equal(result.stdout,'');
            await assert.rejects(fs.stat(path.join(cliOutput,'asset.json')),{code:'ENOENT'});
        }
    }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('The progress CLI does not turn unrelated build errors into a resource error event',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-cli-unrelated-error-')));
    try{
        const result=spawnSync(process.execPath,[buildCli,'--recipe',path.join(root,'missing.json'),'--output',path.join(root,'output'),'--progress'],{encoding:'utf8',timeout:30_000,cwd:root});
        assert.equal(result.error,undefined);
        assert.equal(result.status,1);
        assert.equal(result.stdout,'');
        assert.match(result.stderr,/ENOENT/);
    }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('A createRequire plugin still builds, unpacks, imports and executes with source-resource validation enabled',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-create-require-resource-')));
    try{
        await fs.mkdir(path.join(root,'source/src'),{recursive:true});
        await fs.writeFile(path.join(root,'source/src/index.ts'),portableSources[0]);
        const result=await buildRecipe({recipe,recipePath:path.join(root,'recipe.json'),output:path.join(root,'output')});
        const[built]=await readyManifest(result.manifest),artifact=built.artifacts[0],unpacked=path.join(root,'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath,artifact.descriptor,{destination:unpacked});
        const{default:plugin}=await import(pathToFileURL(path.join(unpacked,artifact.descriptor.entrypoint)));
        assert.equal(await plugin(),'plugin');
    }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('npm TypeScript compilation also rejects a module-relative resource instead of relocating its URL',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-npm-ts-resource-')));
    try{
        await fs.mkdir(path.join(root,'node_modules/fixture/dist'),{recursive:true});
        await fs.writeFile(path.join(root,'node_modules/fixture/dist/index.ts'),anchoredReads[0]);
        await fs.writeFile(path.join(root,'node_modules/fixture/dist/prompt.txt'),'NPM_RESOURCE');
        await assert.rejects(compileNpmTypeScript({source:{package:'fixture',entrypoint:'dist/index.ts'}},{directory:root}),/node_modules\/fixture\/dist\/index.ts.*читает ресурс/);
    }finally{await fs.rm(root,{recursive:true,force:true});}
});
