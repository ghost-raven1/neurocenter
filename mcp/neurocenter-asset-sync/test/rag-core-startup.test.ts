import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {workspaceFixture} from './bridge-fixture.js';
import {mcpSource} from './runtime-probe-fixture.js';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash} from '../src/bridge/state.js';
import {install} from '../src/bridge/installer.js';
import {projectBindingId} from '../src/bridge/workspace.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import {runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {probeInstalledRagMcp} from '../src/features/rag-ui/mcp-startup.js';

describe('Core-only RAG startup proves the installed MCP without a UI or model call',()=>{
    let f:Awaited<ReturnType<typeof workspaceFixture>>,pkg:Package,log:string;
    beforeEach(async()=>{
        f=await workspaceFixture();log=path.join(f.temporary,'methods.log');
        const {archive,descriptor}=artifactFixture([{path:'opencode-rag.mjs',content:mcpSource(log)}],runtimeArtifactTarget());
        pkg={schemaVersion:5,plugin:{id:'core-rag-startup',name:'Core RAG',kind:'mcp',version:1},files:[],manifest:{sha256:'',filesCount:0},
            config:{command:'node',entrypoint:'opencode-rag.mjs',args:['mcp'],extra:{runtimeArtifacts:[descriptor],
                ragCore:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'},hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}}};
        rehash();await ensureRuntimeArtifact(pkg,{download:async()=>Readable.from([archive])});await install('test-project',pkg,async()=>{},async()=>{});
    });
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(f.temporary,{recursive:true,force:true});vi.unstubAllEnvs();});
    function rehash(){pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:5,plugin:pkg.plugin,config:pkg.config,files:[]})));}
    it('actual initialize and lists succeed for the fixed core entrypoint',async()=>{
        expect(await probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,async()=>{})).toMatchObject({tools:1,resources:1,prompts:1});
        expect((await fs.readFile(log,'utf8')).trim().split('\n')).toEqual(['initialize','notifications/initialized','tools/list','resources/list','prompts/list']);
    },15_000);
    it('legacy UI metadata still initializes the same fixed MCP without a model request',async()=>{
        const {ragCore,...extra}=pkg.config!.extra!;pkg.config!.extra={...extra,localUi:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']}};
        rehash();await install('test-project',pkg,async()=>{},async()=>{});
        expect(await probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,async()=>{})).toMatchObject({tools:1});
        expect(await fs.readFile(log,'utf8')).not.toContain('tools/call');
    },15_000);
    it('an explicit required configuration still blocks startup before any child is created',async()=>{
        pkg.config!.extra!.localConfiguration={schemaVersion:1,fields:[{id:'other',label:'Other',type:'string',required:true,target:{kind:'env',name:'OTHER'}}]};
        rehash();await install('test-project',pkg,async()=>{},async()=>{});
        await expect(probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,async()=>{})).rejects.toThrow();
        await expect(fs.stat(log)).rejects.toMatchObject({code:'ENOENT'});
    });
    it('invalid core metadata cannot start a child or fall back to a valid UI descriptor',async()=>{
        pkg.config!.extra!.ragCore={schemaVersion:1,application:'opencode-rag',entrypoint:'other.mjs'};
        pkg.config!.extra!.localUi={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']};rehash();
        const authorize=vi.fn(async()=>{});await expect(probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,authorize)).rejects.toThrow();
        expect(authorize).not.toHaveBeenCalled();await expect(fs.stat(log)).rejects.toMatchObject({code:'ENOENT'});
    });
    it('a valid but different package pin cannot use the installed core files',async()=>{
        pkg.plugin={...pkg.plugin,version:2};rehash();
        await expect(probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,async()=>{})).rejects.toThrow();
        await expect(fs.stat(log)).rejects.toMatchObject({code:'ENOENT'});
    });
    it('revocation after the actual handshake prevents tools/list and a successful result',async()=>{
        await expect(probeInstalledRagMcp('test-project',await projectBindingId('test-project'),pkg,async()=>{
            if((await fs.readFile(log,'utf8').catch(()=>'' )).includes('initialize'))throw new Error('revoked');
        })).rejects.toThrow();
        expect(await fs.readFile(log,'utf8')).toContain('initialize');expect(await fs.readFile(log,'utf8')).not.toContain('tools/list');
    },15_000);
});
