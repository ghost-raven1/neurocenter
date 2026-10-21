import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateAsset,type SkillAsset} from '@neurocenter/asset-contract';
import {readSkillRepository} from '../../../shared/skill-repository.cjs';
import type {BuildConfiguration} from './package-build.model';
import {inspectSkillSource} from './skill-source';

/** Skills are data: no npm, runtime builder or upstream code executes during packaging. */
export async function buildSkillAsset(config:BuildConfiguration,stage:string){
    if(config.kind!=='skill'||config.source.type!=='files'&&config.source.type!=='repository')throw new Error('Нужны исходники скилла.');
    const files=config.source.type==='files'?config.source.files:await readSkillRepository(config.source,stage);
    const sorted=[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const parsed=inspectSkillSource(sorted,{name:config.name,description:config.description,entrypoint:config.source.entrypoint});
    const card:SkillAsset['card']={path:'common',slug:parsed.slug,name:parsed.name,body:parsed.body,meta:{...parsed.meta,...(config.tags.length?{tags:config.tags}:{})},resources:parsed.resources};
    const snapshot=Buffer.from(JSON.stringify({schemaVersion:1,files:sorted})+'\n'),sourceSha=createHash('sha256').update(snapshot).digest('hex');
    const repositoryPath=config.source.type==='repository'?[config.source.subdirectory,path.posix.dirname(config.source.entrypoint)==='.'?undefined:path.posix.dirname(config.source.entrypoint)].filter(Boolean).join('/'):undefined;
    const source:SkillAsset['source']=config.source.type==='repository'
        ?{type:'git',repository:config.source.url,commit:config.source.commit,...(repositoryPath?{path:repositoryPath}:{})}
        :{type:'archive',sha256:sourceSha,bytes:snapshot.length};
    const version='source-'+createHash('sha256').update(JSON.stringify({source,card})).digest('hex');
    const asset=validateAsset({schemaVersion:1,id:'skill-'+parsed.slug,kind:'skill',version,source,license:{spdx:'NOASSERTION'},compatibility:{packageFormat:5},card,delivery:{type:'inline'}}) as SkillAsset;
    let sourceFile: {archivePath:string}|undefined;
    if(source.type==='archive'){
        const archivePath=path.join(stage,'skill-source.json');await fs.writeFile(archivePath,snapshot,{flag:'wx',mode:0o600});sourceFile={archivePath};
    }
    return {asset,sourceFile};
}
