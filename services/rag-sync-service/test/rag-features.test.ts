import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {RagService} from '../src/rag/rag.service';
import {ProjectRagController} from '../src/rag/project-rag.controller';
import {projectRagContext} from '../src/rag/project-rag-context';
import {write} from './rag-write.fixture';
vi.mock('../src/rag/project-rag-context',()=>({projectRagContext:vi.fn()}));
const context=()=>({projectId:'prj-search',generation:'initial-'+'a'.repeat(32),revision:1,dataRevision:2,
    profile:{provider:'openai',model:'selected',dimension:3},snapshot:'b'.repeat(64)});
let flags=defaultFeatureFlags(),unavailable=false,calls:string[],db:any,databases:any,service:RagService,controller:ProjectRagController;
beforeEach(()=>{
    flags=defaultFeatureFlags();unavailable=false;calls=[];
    vi.mocked(projectRagContext).mockResolvedValue(context());
    db={search:vi.fn(async()=>({generation:context().generation,snapshot:context().snapshot,sources:[]})),count:vi.fn(async()=>1),
        quota:vi.fn(async()=>({availableBytes:100})),applyDelta:vi.fn(),generations:{get:vi.fn(),create:vi.fn(),retry:vi.fn(),cancel:vi.fn(),source:vi.fn(async()=>({rowCount:1})),build:vi.fn()}};
    databases={withProject:vi.fn(async(id,action)=>action(db,id))};service=new RagService(databases);controller=new ProjectRagController(service,databases);
    vi.stubGlobal('fetch',vi.fn(async(url)=>{calls.push(String(url));if(unavailable)throw Error('private upstream');return new Response(JSON.stringify(evaluateFeatureFlags(flags)));}));
});
afterEach(()=>vi.unstubAllGlobals());
describe('RAG internal and worker feature boundaries',()=>{
    it.each(['project_search','model_hosting'] as const)('disabled %s never reads another database or executes search',async key=>{
        flags[key]=false;await expect(service.search({...context(),embedding:[1,0,0]})).rejects.toMatchObject({status:403});
        expect(databases.withProject).not.toHaveBeenCalled();expect(db.search).not.toHaveBeenCalled();expect(calls).toHaveLength(1);
    });
    it('unavailable flag state is an explicit failure before DB dispatch',async()=>{
        unavailable=true;await expect(service.search({...context(),embedding:[1,0,0]})).rejects.toMatchObject({status:503});expect(databases.withProject).not.toHaveBeenCalled();
    });
    it('enabled search preserves exact context and snapshot validation',async()=>{
        const input={...context(),embedding:[1,0,0]};expect(await service.search(input)).toMatchObject({sources:[]});expect(db.search).toHaveBeenCalledWith(input);
        vi.mocked(projectRagContext).mockResolvedValue({...context(),revision:2});await expect(service.search(input)).rejects.toMatchObject({status:409});expect(db.search).toHaveBeenCalledTimes(1);
    });
    it('disabled sync refuses even a valid intent before external authorization and writes',async()=>{
        flags.rag_sync=false;await expect(service.applyDelta(write())).rejects.toMatchObject({status:403});expect(calls).toHaveLength(1);expect(databases.withProject).not.toHaveBeenCalled();
    });
    it.each(['create','retry','build'] as const)('disabled sync blocks internal generation %s before mutation',async method=>{
        flags.rag_sync=false;
        const request=method==='create'?controller.create({projectId:'prj-search',id:'generation',sourceGeneration:'initial',profile:context().profile,sourceSnapshot:'hash'})
            :controller[method]('generation',{projectId:'prj-search'});
        await expect(request).rejects.toMatchObject({status:403});expect(databases.withProject).not.toHaveBeenCalled();
    });
    it('a stopped next batch cannot charge a second inference, while the completed first result is retained',async()=>{
        const completed:number[][][]=[];let paid=0;
        vi.stubGlobal('fetch',vi.fn(async(url)=>{
            calls.push(String(url));
            if(String(url).endsWith('/internal/feature-flags/evaluated'))return new Response(JSON.stringify(evaluateFeatureFlags(flags)));
            paid++;flags.model_hosting=false;return new Response(JSON.stringify({embeddings:[[1,2,3]]}));
        }));
        db.generations.build.mockImplementation(async(_id,_generation,embed)=>{completed.push(await embed(['first'],context().profile));completed.push(await embed(['second'],context().profile));});
        await expect(service.buildGeneration('prj-search','generation')).rejects.toMatchObject({status:403});expect(paid).toBe(1);expect(completed).toEqual([[[1,2,3]]]);
    });
    it('read, source inspection, quota and cancellation survive all flags off and flag-service outage',async()=>{
        for(const key of Object.keys(flags))flags[key as keyof typeof flags]=false;unavailable=true;
        expect(await service.count('prj-search')).toBe(1);await service.quota('prj-search');await controller.get('generation','prj-search');
        await controller.source({projectId:'prj-search',generation:'generation'});await controller.cancel('generation',{projectId:'prj-search',profile:{},sourceGeneration:'initial',sourceSnapshot:null});
        expect(calls).toEqual([]);expect(db.generations.cancel).toHaveBeenCalledOnce();
    });
});
