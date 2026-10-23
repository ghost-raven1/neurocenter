import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {learningDeferred,learningHooks} from './project-learning-hooks';
import {useLearningQuirksImport} from '../src/features/ProjectLearning/useLearningQuirksImport';
import {quirksImportApi} from '../src/features/ProjectLearning/quirksImportApi';
import type {LearningQuirksJobInput} from '../src/features/ProjectLearning/quirksImportTypes';
import type {IBridgeJob} from '../src/features/McpBridge/api';

const hooks=vi.hoisted(()=>({current:undefined as ReturnType<typeof learningHooks>|undefined}));
const scope=vi.hoisted(()=>({current:'developer'}));
vi.mock('react',()=>({useState:(...args:Parameters<ReturnType<typeof learningHooks>['useState']>)=>hooks.current!.useState(...args),
    useRef:(...args:Parameters<ReturnType<typeof learningHooks>['useRef']>)=>hooks.current!.useRef(...args),useEffect:(...args:Parameters<ReturnType<typeof learningHooks>['useEffect']>)=>hooks.current!.useEffect(...args),useCallback:<T>(callback:T)=>callback}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const captured=scope.current;return {scope:captured,captureOwner:()=>()=>captured===scope.current};}}));
vi.mock('../src/features/ProjectLearning/quirksImportApi',()=>({quirksImportApi:{create:vi.fn()}}));
vi.mock('../src/features/McpBridge/api',()=>({bridgeApi:{cancel:vi.fn()}}));
vi.mock('../src/features/McpBridge/bridgeRequestKey',()=>({createBridgeRequestKey:()=> '11111111-1111-4111-8111-111111111111'}));
const input:LearningQuirksJobInput={kind:'import-learning-quirks',projectId:'prj-quirks',deviceId:'device-fixture',assetId:'rag',assetKind:'mcp',version:12,
    expectedManifest:'a'.repeat(64),expectedBindingId:'b'.repeat(64),expectedInstanceId:'22222222-2222-4222-8222-222222222222',expectedConfigurationRevisions:[]};
const job={id:'job-fixture',projectId:input.projectId,deviceId:input.deviceId,kind:input.kind,state:'queued'} as IBridgeJob;
let projectId:string;const reload=vi.fn(async()=>{});
const render=()=>{hooks.current!.begin();const result=useLearningQuirksImport(projectId,reload);hooks.current!.commit();return result;};
beforeEach(()=>{vi.clearAllMocks();hooks.current=learningHooks();scope.current='developer';projectId=input.projectId;vi.mocked(quirksImportApi.create).mockResolvedValue(job);});
afterEach(()=>{hooks.current?.dispose();});
describe('Quirk job intent and late context ownership',()=>{
    it('locks duplicate clicks and reuses exact request key after a lost acknowledgement',async()=>{
        vi.mocked(quirksImportApi.create).mockRejectedValueOnce(new Error('ACK lost')).mockResolvedValueOnce(job);
        await render().submit(input);expect(render().error).not.toBe('');await render().submit(input);
        expect(vi.mocked(quirksImportApi.create).mock.calls[1]).toEqual(vi.mocked(quirksImportApi.create).mock.calls[0]);expect(render().submitted?.id).toBe(job.id);
    });
    it.each(['role','project'])('late %s response cannot become a result of the new context',async change=>{
        const pending=learningDeferred<IBridgeJob>();vi.mocked(quirksImportApi.create).mockReturnValue(pending.promise);
        const actions=render(),request=actions.submit(input);await actions.submit(input);expect(quirksImportApi.create).toHaveBeenCalledOnce();
        if(change==='role')scope.current='observer';else projectId='another-project';render();pending.resolve(job);await request;
        expect(render().submitted).toBeUndefined();expect(reload).not.toHaveBeenCalled();
    });
    it('a stale captured callback cannot submit after role change',async()=>{
        const actions=render();scope.current='reader';await actions.submit(input);expect(quirksImportApi.create).not.toHaveBeenCalled();
    });
});
