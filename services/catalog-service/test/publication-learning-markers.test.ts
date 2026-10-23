import {describe,expect,it} from 'vitest';
import {validatePublication} from '../src/publication/publication-validation';
import {buildPackage,verifyPackage} from '../src/catalog/bundle-package';
import {MEMORY_RECIPE,memoryRecipeSupported} from '../../shared/project-learning-memory-sync.cjs';
import {QUIRKS_SOURCE_SHA256,supportsLearningQuirks} from '../../shared/project-learning-quirks.cjs';

const artifact=(entrypoint:string)=>({target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint});
const memory=()=>({name:'MCP Memory',description:'Approved project knowledge projection',kind:'mcp',files:[],config:{transport:'stdio',command:'node',entrypoint:'entrypoint.mjs',args:[],extra:{
    runtimeArtifacts:[artifact('entrypoint.mjs')],learningMemory:{...MEMORY_RECIPE}}}});
const quirks=(kind:'mcp'|'plugin')=>({name:'OpenCodeRAG',description:'Reported quirks from pinned upstream JSONL',kind,files:[],config:{...(kind==='mcp'?{transport:'stdio',command:'node',args:['mcp']}:{ }),
    entrypoint:kind==='mcp'?'opencode-rag.mjs':'rag-plugin.mjs',extra:{runtimeArtifacts:[artifact(kind==='mcp'?'opencode-rag.mjs':'rag-plugin.mjs')],
        localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']},
        learningQuirks:{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:QUIRKS_SOURCE_SHA256}}}});

describe('Learning producer descriptors survive the actual catalog publication boundary',()=>{
    it('published Memory remains an eligible installed target after package normalization',()=>{
        const value=validatePublication(memory()),pkg=buildPackage({id:'qa-memory',name:value.name,kind:'mcp',version:1},[],'',value.config);
        expect(verifyPackage(pkg)).toBe(true);expect(memoryRecipeSupported(pkg)).toBe(true);
        expect(value.config?.extra?.learningMemory).toEqual(MEMORY_RECIPE);
    });
    it.each(['mcp','plugin'] as const)('published RAG %s retains its exact reviewed JSONL source marker',kind=>{
        const value=validatePublication(quirks(kind)),pkg=buildPackage({id:'qa-rag',name:value.name,kind,version:1},[],'',value.config);
        expect(verifyPackage(pkg)).toBe(true);expect(supportsLearningQuirks(pkg)).toBe(true);
    });
    it.each([null,{...MEMORY_RECIPE,version:'99.0.0'},{...MEMORY_RECIPE,shell:'sh'},{schemaVersion:1}])('rejects malformed Memory ABI: %j',learningMemory=>{
        const value=memory();expect(()=>validatePublication({...value,config:{...value.config,extra:{...value.config.extra,learningMemory}}})).toThrow();
    });
    it.each([null,{schemaVersion:1,format:'other',sourceSha256:QUIRKS_SOURCE_SHA256},{schemaVersion:1,format:'opencode-rag-quirks-jsonl',sourceSha256:'b'.repeat(64)}])('rejects another RAG source: %j',learningQuirks=>{
        const value=quirks('mcp');expect(()=>validatePublication({...value,config:{...value.config,extra:{...value.config.extra,learningQuirks}}})).toThrow();
    });
    it('does not grant either marker to a remote or missing runtime, or Memory to a plugin',()=>{
        const value=memory();
        expect(()=>validatePublication({...value,kind:'plugin'})).toThrow();
        expect(()=>validatePublication({...value,config:{...value.config,transport:'remote',url:'https://example.test/mcp'}})).toThrow();
        expect(()=>validatePublication({...value,config:{...value.config,extra:{...value.config.extra,runtimeArtifacts:[]}}})).toThrow();
        const rag=quirks('mcp');expect(()=>validatePublication({...rag,config:{...rag.config,extra:{...rag.config.extra,localUi:undefined}}})).toThrow();
    });
});
