import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,expect,it,vi} from 'vitest';
import {assetDigest} from '@neurocenter/asset-contract';
import {readBundledCatalog} from '../../shared/bundled-catalog.cjs';
import {validateBuildInput} from '../src/package-build/package-build.model';
import {resolveBundledBuild,stageBundledBuild,assertBundledPublication} from '../src/package-build/bundled-source';
import {buildFeatures} from '../src/package-build/codex-connector-build';
import {bridgeReleaseView,readBridgeSource} from '../src/asset-sources/bridge-source-feed';
import type {ISourceSnapshot} from '../src/asset-sources/source-snapshots';

const base={requestKey:'22222222-2222-4222-8222-222222222222',kind:'plugin',name:'OpenCodeRAG',description:'Проверенная текущая версия'};
describe('Current Git recipe uses the established build/publication boundary',()=>{
    it('Pins exact current RAG, constrains platforms and requires source, build and runtime flags independently',async()=>{
        const bundle=await readBundledCatalog(),source={type:'bundled',id:'plugin-opencode-rag-plugin',revision:bundle.revision} as const;
        const input=validateBuildInput({...base,source}),resolved=await resolveBundledBuild(source,'plugin');
        expect(input.source).toEqual(source);expect(resolved.recipe.revision).toBe('2.12.2-plugin.pack.1');expect(resolved.targets).not.toContain('darwin-x64');
        expect(buildFeatures(input)).toEqual(expect.arrayContaining(['asset_sources','tool_builds','tool_catalog','tool_build_validation']));
        await expect(resolveBundledBuild(source,'mcp')).rejects.toMatchObject({status:400});
        await expect(resolveBundledBuild(source,'plugin',['darwin-x64'])).rejects.toMatchObject({status:400});
    });
    it('Rejects path/command injection, agent mutation, stale source revision and archive-only components',async()=>{
        const bundle=await readBundledCatalog(),source={type:'bundled',id:'plugin-opencode-rag-plugin',revision:bundle.revision} as const;
        expect(()=>validateBuildInput({...base,source:{...source,path:'/etc/passwd'}})).toThrow();
        expect(()=>validateBuildInput({...base,source,agent:{modelId:'x',expectedModelPin:'x',maxAttempts:1}})).toThrow();
        await expect(resolveBundledBuild({...source,revision:'0'.repeat(64)},'plugin')).rejects.toMatchObject({status:409});
        await expect(resolveBundledBuild({...source,id:'plugin-opencode-snip'},'plugin')).rejects.toMatchObject({status:409});
    });
    it('Stages Python source from the declared app closure and preserves its stable source asset identity',async()=>{
        const bundle=await readBundledCatalog(),source={type:'bundled',id:'plugin-python-context',revision:bundle.revision} as const;
        const stage=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc bundled stage ')));
        try{const recipe=await stageBundledBuild(source,'plugin',['darwin-arm64'],stage);expect(recipe.key).toBe(source.id);expect(recipe.source.directory).toBe('source');
            expect(await fs.readFile(path.join(stage,'source/index.ts'),'utf8')).toContain('python');
            expect(await fs.readdir(stage)).toEqual(['source']);
            expect(recipe.producer).toMatchObject({id:source.id,revision:source.revision,producerSha256:bundle.producerSha256});
            const bytes=Buffer.from(JSON.stringify({producer:recipe.producer})),sourceSnapshotPath=path.join(stage,'snapshot.json');await fs.writeFile(sourceSnapshotPath,bytes);
            const checked={sourceSnapshotPath,asset:{source:{type:'archive',sha256:assetDigest(bytes),bytes:bytes.length}}};
            await expect(assertBundledPublication(source,checked)).resolves.toBeUndefined();
            await fs.writeFile(sourceSnapshotPath,'{}');await expect(assertBundledPublication(source,checked)).rejects.toMatchObject({status:409});
        }finally{await fs.rm(stage,{recursive:true,force:true});}
    });
    it('Retired bridge feed returns archive-required before HTTP and never advertises a cached old release as current',async()=>{
        const request=vi.fn(async()=>{throw Error('Unexpected network');});
        await expect(readBridgeSource('https://github.com/ghost-raven1/neurocenter-assets',new AbortController().signal,request)).rejects.toMatchObject({status:409,response:{sourceReady:false,archiveRequired:true}});
        expect(request).not.toHaveBeenCalled();
        expect(bridgeReleaseView({pin:{repository:'ghost-raven1/neurocenter-assets'},assets:[]} as unknown as ISourceSnapshot)).toBeUndefined();
    });
});
