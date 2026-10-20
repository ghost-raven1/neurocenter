import {createToolAsset,serializeAsset} from '@neurocenter/asset-contract';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {artifactFixture} from '../../test/runtime-artifact-fixture.cjs';
import {readyManifest} from '../manifest.mjs';
import {toolRuntimePath} from '../supply-layout.mjs';

const localUi={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']};
async function fixture(kind,files,run){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-ready-rag-ui-')));
    try{
        const artifact=artifactFixture(files,'darwin-arm64');
        const descriptor={...artifact.descriptor,entrypoint:kind==='mcp'?'opencode-rag.mjs':'rag-plugin.mjs'};
        await fs.mkdir(path.join(root,'artifacts'));await fs.writeFile(path.join(root,toolRuntimePath(descriptor.sha256)),artifact.archive);await fs.writeFile(path.join(root,'runtime.json'),JSON.stringify(descriptor));
        const publication={name:'OpenCodeRAG '+kind,kind,description:'Проверка UI поставки',revision:'fixture.pack.5',files:[],config:{...(kind==='mcp'?{transport:'stdio',args:['mcp']}:{entrypoint:'rag-plugin.mjs'}),extra:{runtimeArtifacts:[descriptor],localUi,hostedEmbedding:{schemaVersion:1}}}};
        const asset=createToolAsset({id:'rag-'+kind,version:'fixture-v1',source:{type:'npm',name:'fixture-rag',version:'1.0.0'},license:{spdx:'NOASSERTION'},publication,artifacts:[{descriptor}]});
        const filename=path.join(root,'asset.json');await fs.writeFile(filename,serializeAsset(asset));await run(filename);
    }finally{await fs.rm(root,{recursive:true,force:true});}
}
for(const kind of ['mcp','plugin'])test(`Поставка ${kind} сохраняет hosted-декларацию и проверяет UI файл в настоящей SHA-описи`,async()=>{
    await fixture(kind,[{path:'opencode-rag.mjs',content:'export {};'},...(kind==='plugin'?[{path:'rag-plugin.mjs',content:'export default {};'}]:[])],async filename=>{
        const [ready]=await readyManifest(filename);assert.deepEqual(ready.publication.config.extra.localUi,localUi);assert.equal(ready.artifacts.length,1);assert.deepEqual(ready.publication.config.extra.hostedEmbedding,{schemaVersion:1});
    });
});
test('Плагин с объявленным UI без файла CLI не проходит готовую поставку',async()=>{
    await fixture('plugin',[{path:'rag-plugin.mjs',content:'export default {};'}],async filename=>{
        await assert.rejects(readyManifest(filename),/localUi.*описи/);
    });
});
test('Плагин с пустым UI файлом не проходит готовую поставку',async()=>{
    await fixture('plugin',[{path:'rag-plugin.mjs',content:'export default {};'}, {path:'opencode-rag.mjs',content:''}],async filename=>{
        await assert.rejects(readyManifest(filename),/localUi.*описи/);
    });
});
