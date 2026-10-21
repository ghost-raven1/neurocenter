import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ModelsService} from '../src/models/models.service';
import type {ModelChatProjectContext} from '../src/model-chat/chat-project-context';
import type {ConversationRow} from '../src/model-chat/chat.types';
import {buildPackage} from '../src/catalog/bundle-package';
import type {IProjectPinRow} from '../src/catalog/project-asset-pins';
import {evaluateFeatureFlags,defaultFeatureFlags} from '../../shared/feature-flags.cjs';
import {assertResearchPackage,ChatResearchTools} from '../src/model-chat/chat-research-tools';
import {researchRequest} from '../src/model-chat/chat-research-input';

const config={transport:'stdio'as const,args:[],extra:{hostedMcp:true,researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']},
    runtimeArtifacts:[{target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'entrypoint.mjs'}]}};
const native=()=>buildPackage({id:'search',name:'Exa · одобренный поиск',kind:'mcp',version:2},[],'2026-10-22',structuredClone(config));
const row=(pkg=native()):IProjectPinRow=>({project_id:'project',asset_id:pkg.plugin.id,asset_kind:'mcp',added_by:'owner',added_at:'2026-10-22',
    asset_version:pkg.plugin.version,asset_manifest:pkg.manifest.sha256,pin_origin:'assigned',pin_snapshot:{card:{name:pkg.plugin.name},package:pkg}});
const conversation={id:'chat',project_id:'project',model_id:'chat-model'}as ConversationRow;
let items:IProjectPinRow[],configured=defaultFeatureFlags(),resolve:ReturnType<typeof vi.fn>,query:ReturnType<typeof vi.fn>,overview:ReturnType<typeof vi.fn>;
const tools=()=>new ChatResearchTools({resolveProject:resolve,pool:{query}}as unknown as ModelsService,{overview}as unknown as ModelChatProjectContext);
const req={}as Parameters<ChatResearchTools['choices']>[0];
beforeEach(()=>{
    items=[row()];configured=defaultFeatureFlags();resolve=vi.fn(async()=>({id:'project'}));query=vi.fn(async()=>({rows:items}));overview=vi.fn(async()=>({status:'ready',sources:[]}));
    vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','unit-only');vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags(configured)),{status:200})));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('Явный запрос исследования',()=>{
    it('Пустое поле не меняет обычный чат; исследование требует проект и exact pin',()=>{
        expect(researchRequest(undefined,null)).toBeNull();expect(researchRequest(null,null)).toBeNull();
        expect(()=>researchRequest({project:true},null)).toThrow('выберите проект');
        expect(researchRequest({project:false,external:{assetId:'search',version:2,manifest:'b'.repeat(64)}},'project')).toEqual({project:false,external:{assetId:'search',version:2,manifest:'b'.repeat(64)}});
    });
    it.each([{project:false},{project:'true'},{project:true,commands:['shell']},{project:true,external:{assetId:'search',version:0,manifest:'b'.repeat(64)}},
        {project:true,external:{assetId:'search',version:2,manifest:'latest'}},{project:true,external:{assetId:'search',version:2,manifest:'b'.repeat(64),url:'https://private.invalid'}}])('Не принимает неполный или расширенный запрос %j',input=>{
        expect(()=>researchRequest(input,'project')).toThrow();
    });
});

describe('Поисковые инструменты принадлежат exact назначению проекта',()=>{
    it('Читает только метаданные, не вызывает MCP или модель, возвращает серверные пределы',async()=>{
        const result=await tools().choices(req,conversation);expect(result.project.available).toBe(true);expect(result.external).toEqual([{assetId:'search',name:'Exa · одобренный поиск',version:2,manifest:native().manifest.sha256,available:true}]);
        expect(result.limits.stepsPerRecipient).toBe(6);expect(result.limits.externalCallsPerRound).toBe(16);expect(overview).toHaveBeenCalledOnce();
        expect(vi.mocked(fetch).mock.calls.every(([url])=>String(url).includes('/internal/feature-flags/evaluated'))).toBe(true);
    });
    it('Повторяет ACL до возврата метаданных, не переносит список в другой проект',async()=>{
        await tools().choices(req,conversation);expect(resolve).toHaveBeenCalledTimes(2);expect(query.mock.calls[0][1]).toEqual(['project']);
        resolve.mockRejectedValueOnce(new Error('forbidden'));await expect(tools().choices(req,conversation)).rejects.toThrow('forbidden');
    });
    it('Off и неготовый индекс дают причины, но не вызывают модель и не скрывают metadata history',async()=>{
        configured.research_tools=false;const disabled=await tools().choices(req,conversation);expect(disabled.project.available).toBe(false);expect(disabled.external[0].available).toBe(false);
        configured.research_tools=true;overview.mockResolvedValue({status:'metadata',message:'Выберите embedding-модель'});const missing=await tools().choices(req,conversation);expect(missing.project.reason).toBe('Выберите embedding-модель');expect(missing.external[0].available).toBe(true);
    });
    it('Без проекта не читает чужие назначения или флаги',async()=>{
        expect((await tools().choices(req,{...conversation,project_id:null})).external).toEqual([]);expect(query).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
    it('При удалении/перезакреплении/повреждении pin отказ до вызова Gateway',async()=>{
        const ref={assetId:'search',version:2,manifest:native().manifest.sha256};expect((await tools().resolve(req,conversation,ref)).manifest.sha256).toBe(ref.manifest);
        items=[];await expect(tools().resolve(req,conversation,ref)).rejects.toThrow('изменились');
        items=[{...row(),asset_version:3}];await expect(tools().resolve(req,conversation,ref)).rejects.toThrow('изменились');
        const broken=row();broken.pin_snapshot!.package.config!.extra!.hostedMcp=false;items=[broken];await expect(tools().resolve(req,conversation,ref)).rejects.toThrow();
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([
        {...native(),schemaVersion:4}, {...native(),config:{transport:'remote',url:'https://mcp.exa.ai/mcp',extra:config.extra}},
        {...native(),config:{...config,extra:{...config.extra,hostedMcp:false}}},
        {...native(),config:{...config,extra:{...config.extra,researchMcp:{adapter:'exa',tools:['shell']}}}},
    ])('Не поднимает произвольную конфигурацию до research grant',pkg=>{expect(()=>assertResearchPackage(pkg as ReturnType<typeof native>)).toThrow();});
});
