import {describe,expect,it} from 'vitest';
import {localRagCore} from '../src/features/rag-core/contract.js';
import {localRagUi} from '../src/features/rag-ui/contract.js';
import {missingLaunchFields} from '../src/features/local-configuration/launch-fields.js';
import {BRIDGE_CAPABILITIES} from '../src/bridge/protocol.js';
import type {Package} from '../src/bridge/package.js';

const core={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'};
const ui={...core,args:['ui','--port','0','--no-open']};
const pkg={schemaVersion:5,plugin:{kind:'mcp'},config:{extra:{runtimeArtifacts:[{}],ragCore:core,hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}}};
describe('Fixed engine identity and exact legacy compatibility',()=>{
    it.each(['mcp','plugin'])('core-only %s is recognized independently of UI without changing its input',kind=>{
        const value={...pkg,plugin:{kind}},before=JSON.stringify(value);expect(localRagCore(JSON.parse(before))).toEqual(core);
        expect(localRagUi(value)).toBeUndefined();expect(JSON.stringify(value)).toBe(before);expect(BRIDGE_CAPABILITIES).toContain('hosted-rag-core-v1');
    });
    it('existing UI-only packages retain engine compatibility and do not gain new metadata',()=>{
        const value={...pkg,config:{extra:{runtimeArtifacts:[{}],localUi:ui}}},before=JSON.stringify(value);
        expect(localRagCore(value)).toEqual(core);expect(localRagUi(value)).toEqual(ui);expect(JSON.stringify(value)).toBe(before);
        expect(localRagCore({...pkg,config:null})).toBeUndefined();
    });
    it.each([{entrypoint:'../other.mjs'},{args:['reindex']},{application:'other'},{command:'node'},{schemaVersion:2},null])('bad explicit metadata cannot fall back to legacy UI: %j',changed=>{
        const value={...pkg,config:{extra:{...pkg.config.extra,localUi:ui,ragCore:changed===null?null:{...core,...changed}}}};
        expect(()=>localRagCore(value)).toThrow();
    });
    it.each([{schemaVersion:1},{schemaVersion:1,profileSchemaVersion:1,reindexSchemaVersion:1},
        {schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:2},{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1,endpoint:'https://other.test'}])('new core requires the exact hosted ABI: %j',hostedEmbedding=>{
        expect(()=>localRagCore({...pkg,config:{extra:{...pkg.config.extra,hostedEmbedding}}})).toThrow();
    });
    it('remote transport or an unpinned file package cannot declare this engine',()=>{
        expect(()=>localRagCore({...pkg,config:{...pkg.config,transport:'remote'}})).toThrow();
        expect(()=>localRagCore({...pkg,config:{extra:{...pkg.config.extra,runtimeArtifacts:[]}}})).toThrow();
    });
    it('core defaults preserve saved values, required schema and unrelated missing fields',()=>{
        const schema={schemaVersion:1 as const,fields:[{id:'embeddingUrl',label:'URL',type:'url' as const,required:true,target:{kind:'env' as const,name:'NEUROCENTER_RAG_EMBEDDING_URL'}},
            {id:'embeddingModel',label:'Model',type:'string' as const,required:true,target:{kind:'env' as const,name:'NEUROCENTER_RAG_EMBEDDING_MODEL'}},
            {id:'other',label:'Other',type:'string' as const,required:true,target:{kind:'env' as const,name:'OTHER'}}]};
        const values={embeddingModel:'manual-model'},before=JSON.stringify({schema,values});
        expect(missingLaunchFields(pkg as unknown as Package,schema,values)).toEqual(['other']);expect(JSON.stringify({schema,values})).toBe(before);
    });
});
