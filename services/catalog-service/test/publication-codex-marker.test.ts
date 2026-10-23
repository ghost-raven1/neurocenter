import {describe,expect,it} from 'vitest';
import {validatePublication} from '../src/publication/publication-validation';
import {publicationRuntimeExtra} from '../src/publication/publication-runtime';
import {assertCodexBuildPublication} from '../src/package-build/codex-connector-build';
import {CODEX_PLUGIN_SOURCE} from '../../shared/codex-connector-source.cjs';

const pin=require('../../shared/codex-connector-pin.json') as {sourceCommit:string;version:string;sdkVersion:string};
const marker=()=>({schemaVersion:1,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion,authOnly:true});
const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'codex-plugin.mjs'};
const extra=()=>({runtimeArtifacts:[{...artifact}],codexConnector:marker()});
const publication=()=>({name:'OpenCode Codex Bridge',kind:'plugin',description:'Pinned auth-only provider',files:[],
    config:{entrypoint:'codex-plugin.mjs',extra:extra()}});

describe('Pinned Codex metadata through the common publication boundary',()=>{
    it('retains the actual producer marker through normalization and the independent build-provenance gate',()=>{
        const result=validatePublication(publication());
        expect(result.config?.extra?.codexConnector).toEqual(marker());
        expect(result.config?.extra?.runtimeArtifacts).toEqual([artifact]);
        expect(()=>assertCodexBuildPublication({kind:'plugin',source:{type:'repository',...CODEX_PLUGIN_SOURCE}},result)).not.toThrow();
        expect(()=>assertCodexBuildPublication({kind:'plugin',source:{type:'repository',...CODEX_PLUGIN_SOURCE,commit:'b'.repeat(40)}},result)).toThrow('Произвольная');
    });
    it.each([
        null,[],true,'pinned',{},
        {...marker(),schemaVersion:2},{...marker(),authOnly:false},{...marker(),authOnly:'true'},
        {...marker(),sourceCommit:'b'.repeat(40)},{...marker(),version:'99.0.0'},{...marker(),sdkVersion:'99.0.0'},
        {...marker(),command:'sh'},Object.fromEntries(Object.entries(marker()).filter(([key])=>key!=='sdkVersion')),
    ])('rejects an incomplete, altered or extended marker: %j',codexConnector=>{
        expect(()=>publicationRuntimeExtra({...extra(),codexConnector},'plugin')).toThrow();
    });
    it('requires a plugin with validated runtime artifacts, while ordinary publication remains unchanged',()=>{
        expect(()=>publicationRuntimeExtra(extra(),'mcp','stdio')).toThrow();
        expect(()=>publicationRuntimeExtra({codexConnector:marker()},'plugin')).toThrow();
        expect(()=>publicationRuntimeExtra({...extra(),runtimeArtifacts:[]},'plugin')).toThrow();
        expect(()=>publicationRuntimeExtra({...extra(),runtimeArtifacts:[{...artifact,executable:true}]},'plugin')).toThrow();
        expect(()=>publicationRuntimeExtra({...extra(),arbitrary:'ignored'},'plugin')).toThrow();
        expect(publicationRuntimeExtra({runtimeArtifacts:[artifact]},'plugin')).toEqual({runtimeArtifacts:[artifact]});
    });
});
