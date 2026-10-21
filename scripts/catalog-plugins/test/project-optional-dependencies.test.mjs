import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildRecipe} from '../build.mjs';
import {readyManifest} from '../manifest.mjs';
import runtime from '../../../services/shared/runtime-artifacts.cjs';
import {installDependencies} from '../recipes/upstream.mjs';
import fixtures from '../../test/runtime-artifact-fixture.cjs';

const recipe={schemaVersion:1,key:'optional-plugin',name:'Optional plugin',kind:'plugin',revision:'1.0.0',description:'Optional runtime dependency',
    source:{type:'project',directory:'source',entrypoint:'index.cjs'},targets:['darwin-arm64']};

test('Project optional dependencies reach the installed plugin without becoming required dependencies',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-project-optionals-'))),previous=process.env.NPM_CLI_JS;
    try{
        await fs.mkdir(path.join(root,'source'));
        await fs.writeFile(path.join(root,'source/package.json'),JSON.stringify({name:'optional-plugin',type:'commonjs',optionalDependencies:{'optional-helper':'1.0.0'}}));
        await fs.writeFile(path.join(root,'source/index.cjs'),"module.exports=async()=>({value:require('optional-helper').value});");
        const cli=path.join(root,'npm-fixture.mjs');
        await fs.writeFile(cli,`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
const args=process.argv.slice(2),directory=args[args.indexOf('--prefix')+1],manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
assert.deepEqual(manifest.dependencies,{});assert.deepEqual(manifest.optionalDependencies,{'optional-helper':'1.0.0'});assert.ok(args.includes('--include=optional'));
const helper=path.join(directory,'node_modules/optional-helper');await fs.mkdir(helper,{recursive:true});
await fs.writeFile(path.join(helper,'package.json'),JSON.stringify({name:'optional-helper',version:'1.0.0',main:'index.cjs'}));
await fs.writeFile(path.join(helper,'index.cjs'),"exports.value='OPTIONAL_RUNTIME';");
await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
`);
        process.env.NPM_CLI_JS=cli;
        const result=await buildRecipe({recipe,recipePath:path.join(root,'recipe.json'),output:path.join(root,'output')});
        const[built]=await readyManifest(result.manifest),artifact=built.artifacts[0],unpacked=path.join(root,'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath,artifact.descriptor,{destination:unpacked});
        const{default:plugin}=await import(pathToFileURL(path.join(unpacked,artifact.descriptor.entrypoint)));
        assert.deepEqual(await plugin(),{value:'OPTIONAL_RUNTIME'});
    }finally{
        if(previous===undefined)delete process.env.NPM_CLI_JS;else process.env.NPM_CLI_JS=previous;
        await fs.rm(root,{recursive:true,force:true});
    }
});

test('A project still packages when npm skips every optional dependency for the selected platform',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-skipped-optionals-'))),previous=process.env.NPM_CLI_JS;
    try{
        await fs.mkdir(path.join(root,'source'));
        await fs.writeFile(path.join(root,'source/package.json'),JSON.stringify({name:'optional-plugin',optionalDependencies:{'foreign-helper':'1.0.0'}}));
        await fs.writeFile(path.join(root,'source/index.cjs'),"module.exports=async()=>({value:'FALLBACK'});");
        const cli=path.join(root,'npm-fixture.mjs');
        await fs.writeFile(cli,`import fs from'node:fs/promises';import path from'node:path';const args=process.argv.slice(2),directory=args[args.indexOf('--prefix')+1];await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));`);
        process.env.NPM_CLI_JS=cli;
        const result=await buildRecipe({recipe,recipePath:path.join(root,'recipe.json'),output:path.join(root,'output')});
        const[built]=await readyManifest(result.manifest),artifact=built.artifacts[0],unpacked=path.join(root,'unpacked');
        await runtime.inspectRuntimeArchive(artifact.archivePath,artifact.descriptor,{destination:unpacked});
        const{default:plugin}=await import(pathToFileURL(path.join(unpacked,artifact.descriptor.entrypoint)));
        assert.deepEqual(await plugin(),{value:'FALLBACK'});
    }finally{
        if(previous===undefined)delete process.env.NPM_CLI_JS;else process.env.NPM_CLI_JS=previous;
        await fs.rm(root,{recursive:true,force:true});
    }
});

for(const optionalDependencies of [['invalid'],'invalid',{'optional-helper':'file:../outside'},{'optional-helper':'git+https://example.test/private.git'}]){
    test('Invalid optional dependencies fail before invoking npm: '+JSON.stringify(optionalDependencies),async()=>{
        const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-invalid-optionals-'))),previous=process.env.NPM_CLI_JS;
        try{
            await fs.mkdir(path.join(root,'source'));
            await fs.writeFile(path.join(root,'source/package.json'),JSON.stringify({name:'optional-plugin',optionalDependencies}));
            await fs.writeFile(path.join(root,'source/index.cjs'),'module.exports=async()=>({});');
            process.env.NPM_CLI_JS=path.join(root,'must-not-run.js');
            await assert.rejects(buildRecipe({recipe,recipePath:path.join(root,'recipe.json'),output:path.join(root,'output')}),/Зависимости исходников/);
            await assert.rejects(fs.stat(path.join(root,'output/asset.json')),{code:'ENOENT'});
        }finally{
            if(previous===undefined)delete process.env.NPM_CLI_JS;else process.env.NPM_CLI_JS=previous;
            await fs.rm(root,{recursive:true,force:true});
        }
    });
}

test('Real npm keeps foreign-platform optional dependencies optional and installs matching ones offline',async()=>{
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-optional-platform-'))),previous=process.env.NPM_CLI_JS;
    try{
        let npmCli=previous;
        if(!npmCli){
            for(const directory of(process.env.PATH??'').split(path.delimiter)){
                const candidate=await fs.realpath(path.join(directory,'npm')).catch(()=>null);
                if(candidate?.endsWith('.js')){npmCli=candidate;break;}
            }
        }
        assert.ok(npmCli,'Real npm CLI is required for platform dependency verification');
        const archive=path.join(root,'foreign-optional.tgz');
        await fs.writeFile(archive,fixtures.artifactFixture([
            {path:'package/package.json',content:JSON.stringify({name:'foreign-optional',version:'1.0.0',main:'index.cjs',os:['linux'],cpu:['x64'],scripts:{install:'node -e "process.exit(71)"'}})},
            {path:'package/index.cjs',content:"exports.value='PLATFORM_RUNTIME';"},
        ]).archive);
        const cli=path.join(root,'offline-npm.mjs');
        await fs.writeFile(cli,`import{execFileSync}from'node:child_process';execFileSync(process.execPath,[${JSON.stringify(npmCli)},...process.argv.slice(2),'--offline'],{stdio:'inherit'});`);
        process.env.NPM_CLI_JS=cli;
        const optionalDependencies={'foreign-optional':pathToFileURL(archive).href};
        const foreign=path.join(root,'darwin'),matching=path.join(root,'linux');
        await installDependencies(foreign,{},'darwin-arm64',{optionalDependencies});
        await assert.rejects(fs.stat(path.join(foreign,'node_modules/foreign-optional')),{code:'ENOENT'});
        await installDependencies(matching,{},'linux-x64-glibc',{optionalDependencies});
        assert.equal(await fs.readFile(path.join(matching,'node_modules/foreign-optional/index.cjs'),'utf8'),"exports.value='PLATFORM_RUNTIME';");
        const manifest=JSON.parse(await fs.readFile(path.join(matching,'package.json'),'utf8'));
        assert.deepEqual(manifest.dependencies,{});
        assert.deepEqual(manifest.optionalDependencies,optionalDependencies);
    }finally{
        if(previous===undefined)delete process.env.NPM_CLI_JS;else process.env.NPM_CLI_JS=previous;
        await fs.rm(root,{recursive:true,force:true});
    }
});
