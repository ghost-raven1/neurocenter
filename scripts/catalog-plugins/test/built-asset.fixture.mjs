import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createToolAsset,serializeAsset} from '@neurocenter/asset-contract';
import {toolRuntimePath} from '../supply-layout.mjs';
const {artifactFixture}=createRequire(import.meta.url)('../../test/runtime-artifact-fixture.cjs');
export async function builtAssetFixture(t,{kind='plugin',files,extra={}}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc checked source asset ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const fixture=artifactFixture(files,'darwin-arm64'),descriptor=fixture.descriptor;
    const publication={name:'Example '+kind,kind,description:'Проверочный исходный asset',origin:'npm:fixture-example',revision:'1.2.3',files:[],config:{...(kind==='mcp'?{transport:'stdio',args:[]}:{}),extra:{...extra,runtimeArtifacts:[descriptor]}}};
    const asset=createToolAsset({id:'example-'+kind,version:'source-v1',source:{type:'npm',name:'fixture-example',version:'1.2.3'},license:{spdx:'NOASSERTION'},publication,artifacts:[{descriptor}]});
    const archive=path.join(root,toolRuntimePath(descriptor.sha256)),filename=path.join(root,'asset.json');await fs.mkdir(path.dirname(archive),{recursive:true});await fs.writeFile(archive,fixture.archive);
    const save=async(value=asset)=>fs.writeFile(filename,serializeAsset(value));await save();
    return {root,filename,asset,archive,descriptor,publication,save};
}
