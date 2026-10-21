import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {inspectBuildOutput} from './build.mjs';
import {packRuntime} from './pack.mjs';
import {exportBuiltAsset} from './source-envelope.mjs';
import {readyManifest} from './manifest.mjs';
import {toolRuntimePath} from './supply-layout.mjs';
import runtime from '../../services/shared/runtime-artifacts.cjs';

const root=fileURLToPath(new URL('../../',import.meta.url)),sourceDirectory=fileURLToPath(new URL('./plugins/exa-research',import.meta.url));
const gatewayModules=path.join(root,'services/api-gateway/node_modules');
const require=createRequire(new URL('../../frontend/package.json',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Reproducible native supply: bundled SDK, public source snapshot, licenses and all eight JS targets. No npm or keys on installation. */
export async function prepareExaResearch(output){
    const destination=await inspectBuildOutput(output);await fs.mkdir(destination,{recursive:true,mode:0o700});
    const directory=await fs.mkdtemp(path.join(destination,'.build-'));
    try{
        const {build}=require('esbuild'),metadata=JSON.parse(await fs.readFile(path.join(gatewayModules,'@modelcontextprotocol/sdk/package.json'),'utf8'));
        if(metadata.version!=='1.32.1')throw Error('Exa adapter requires the lockfile MCP SDK 1.32.1.');
        const bundled=await build({entryPoints:[path.join(sourceDirectory,'index.mjs')],outfile:path.join(directory,'entrypoint.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',
            nodePaths:[gatewayModules],metafile:true,legalComments:'inline',banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}});
        const packages=new Set();
        for(const input of Object.keys(bundled.metafile.inputs)){
            const absolute=path.resolve(input),parts=absolute.split(path.sep),index=parts.lastIndexOf('node_modules');if(index<0)continue;
            packages.add(parts.slice(0,index+(parts[index+1].startsWith('@')?3:2)).join(path.sep));
        }
        await fs.mkdir(path.join(directory,'licenses'));
        for(const pkg of [...packages].sort()){
            const info=JSON.parse(await fs.readFile(path.join(pkg,'package.json'),'utf8'));
            for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license']){
                try{const bytes=await fs.readFile(path.join(pkg,name));await fs.writeFile(path.join(directory,'licenses',info.name.replace(/[^a-zA-Z0-9.-]/g,'_')+'-'+info.version+'.txt'),bytes,{flag:'wx'});break;}
                catch(error){if(error.code!=='ENOENT')throw error;}
            }
        }
        const temporary=path.join(destination,'runtime.tar.gz'),first=await packRuntime({directory,archivePath:temporary,target:runtime.TARGETS[0],entrypoint:'entrypoint.mjs'});
        const descriptors=runtime.TARGETS.map(target=>({...first,target})),archive=path.join(destination,toolRuntimePath(first.sha256));
        await fs.mkdir(path.dirname(archive),{recursive:true});await fs.rename(temporary,archive);
        const publication={name:'Exa Research MCP',kind:'mcp',description:'Внешний поиск и чтение публичных страниц через существующий Exa MCP. Запросы выполняются на Gateway по явному выбору пользователя; ключи OpenCode не передаются.',
            revision:'1.0.0',tags:['Поиск','Исследование','Gateway'],origin:'https://github.com/exa-labs/exa-mcp-server',compatibility:'Node 24 на Gateway; готовая поставка без npm.',
            config:{transport:'stdio',args:[],extra:{hostedMcp:true,researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']},runtimeArtifacts:descriptors}},files:[]};
        const manifest=await exportBuiltAsset({recipe:{key:'mcp-exa-research',source:{type:'files',directory:'.',entrypoint:'index.mjs'}},recipeDirectory:sourceDirectory,destination,publication,descriptors,
            sources:[{repository:'https://github.com/exa-labs/exa-mcp-server',commit:'0b499f095c4ca145eee07b09137641c037d58449',endpoint:'https://mcp.exa.ai/mcp'}],
            locks:[{name:'api-gateway/package-lock.json',sha256:hash(await fs.readFile(path.join(root,'services/api-gateway/package-lock.json'))),sdk:metadata.version}]});
        await readyManifest(manifest);return {manifest,descriptor:first};
    }finally{await fs.rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')throw Error('Use --output <new supply directory>.');
    await prepareExaResearch(args[1]).then(result=>console.log(JSON.stringify({ok:true,...result})));
}
