import './feature-flags-enabled';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useLearningAnalysis} from '../src/features/ProjectLearning/useLearningAnalysis';
import {projectLearningApi} from '../src/features/ProjectLearning/api';
import {experienceId, learningAnalysis, learningOverview, learningProject, requestKey} from './project-learning-fixtures';
import {flushLearning, learningDeferred, learningHooks} from './project-learning-hooks';

const hooks = vi.hoisted(() => ({current: undefined as ReturnType<typeof learningHooks> | undefined}));
const ui = vi.hoisted(() => ({scope: 'admin'}));
vi.mock('react', () => ({useState: (...args: Parameters<ReturnType<typeof learningHooks>['useState']>) => hooks.current!.useState(...args), useRef: (...args: Parameters<ReturnType<typeof learningHooks>['useRef']>) => hooks.current!.useRef(...args), useEffect: (...args: Parameters<ReturnType<typeof learningHooks>['useEffect']>) => hooks.current!.useEffect(...args)}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const scope = ui.scope; return {scope, captureOwner: () => () => scope === ui.scope};}}));
vi.mock('../src/features/McpBridge/bridgeRequestKey', () => ({createBridgeRequestKey: () => requestKey}));
vi.mock('../src/features/ProjectLearning/api', () => ({projectLearningApi: {analyze: vi.fn(), analysis: vi.fn(), analysisReceipt: vi.fn()}}));
const values = new Map<string, string>(), refresh = vi.fn(), setInterval = vi.fn(), clearInterval = vi.fn();
let props: Parameters<typeof useLearningAnalysis>[0];
function render() {hooks.current!.begin(); const result = useLearningAnalysis(props); hooks.current!.commit(); return result;}
beforeEach(() => {
    vi.clearAllMocks(); hooks.current = learningHooks(); ui.scope = 'admin'; values.clear();
    vi.stubGlobal('sessionStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)});
    vi.stubGlobal('window', {setInterval, clearInterval}); vi.stubGlobal('document', {visibilityState: 'visible'}); setInterval.mockReturnValue(42);
    props = {projectId: learningProject, data: learningOverview(), blocked: false, refresh}; refresh.mockResolvedValue(learningOverview());
    vi.mocked(projectLearningApi.analyze).mockResolvedValue(learningAnalysis()); vi.mocked(projectLearningApi.analysis).mockResolvedValue(learningAnalysis({state: 'running'}));
    vi.mocked(projectLearningApi.analysisReceipt).mockResolvedValue(learningAnalysis());
});
afterEach(() => {hooks.current?.dispose(); vi.unstubAllGlobals();});

describe('AI learning is only triggered by an explicit user action', () => {
    it('Does not generate on mount, refresh or role/project changes', () => {
        render(); render(); ui.scope = 'other'; render(); props = {...props, projectId: 'other'}; render();
        expect(projectLearningApi.analyze).not.toHaveBeenCalled(); expect(setInterval).not.toHaveBeenCalled();
    });
    it('Double click starts one queued job and carries only selected experiences/model/CAS', async () => {
        const pending = learningDeferred<ReturnType<typeof learningAnalysis>>(); vi.mocked(projectLearningApi.analyze).mockReturnValue(pending.promise);
        const actions = render(), first = actions.start([experienceId], 'model-chat', 3); await actions.start([experienceId], 'model-chat', 3);
        expect(projectLearningApi.analyze).toHaveBeenCalledExactlyOnceWith(learningProject, {requestKey, expectedRevision: 3, experienceIds: [experienceId], modelId: 'model-chat'});
        pending.resolve(learningAnalysis()); expect(await first).toBe(true); expect(render().pending).toBe(true);
    });
    it('Polling performs GET only and stops when the job completes', async () => {
        await render().start([experienceId], 'model-chat', 3); render(); expect(setInterval).toHaveBeenCalledOnce();
        vi.mocked(projectLearningApi.analysis).mockResolvedValue(learningAnalysis({state: 'completed', hypothesisIds: ['created']}));
        setInterval.mock.calls[0][0](); await flushLearning(); render(); expect(projectLearningApi.analysis).toHaveBeenCalledOnce(); expect(projectLearningApi.analyze).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce(); expect(clearInterval).toHaveBeenCalledWith(42);
    });
    it('A lost POST is recovered from its key without silently invoking the model again', async () => {
        vi.mocked(projectLearningApi.analyze).mockRejectedValueOnce(new Error('lost ACK')); expect(await render().start([experienceId], 'model-chat', 3)).toBe(false);
        expect(render().unconfirmed).toBe(true); await render().recover(); expect(projectLearningApi.analysisReceipt).toHaveBeenCalledWith(learningProject, requestKey); expect(projectLearningApi.analyze).toHaveBeenCalledOnce(); expect(render().unconfirmed).toBe(false);
    });
    it('A missing receipt stays unknown; explicit same-key resend preserves the original body', async () => {
        vi.mocked(projectLearningApi.analyze).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(learningAnalysis());
        await render().start([experienceId], 'model-chat', 3); vi.mocked(projectLearningApi.analysisReceipt).mockRejectedValue({response: {status: 404}});
        await render().recover(); expect(projectLearningApi.analyze).toHaveBeenCalledOnce(); expect(render()).toMatchObject({notFound: true, unconfirmed: true});
        await render().recover(true); expect(vi.mocked(projectLearningApi.analyze).mock.calls[1]).toEqual(vi.mocked(projectLearningApi.analyze).mock.calls[0]);
    });
    it('Server unknown status does not restart a worker or schedule another generation', async () => {
        vi.mocked(projectLearningApi.analyze).mockResolvedValue(learningAnalysis({state: 'unknown'})); await render().start([experienceId], 'model-chat', 3); render();
        expect(setInterval).not.toHaveBeenCalled(); expect(projectLearningApi.analyze).toHaveBeenCalledOnce(); expect(render().analysis?.state).toBe('unknown');
    });
    it.each(['scope', 'project'])('Late %s analysis result cannot replace current context or trigger its refresh', async kind => {
        const pending = learningDeferred<ReturnType<typeof learningAnalysis>>(); vi.mocked(projectLearningApi.analyze).mockReturnValue(pending.promise); const first = render().start([experienceId], 'model-chat', 3);
        if (kind === 'scope') ui.scope = 'other'; else props = {...props, projectId: 'other'}; render(); pending.resolve(learningAnalysis({state: 'completed'})); expect(await first).toBe(false); expect(refresh).not.toHaveBeenCalled();
    });
    it('Read-only capability and unavailable storage prevent model requests', async () => {
        props = {...props, data: learningOverview({capabilities: {read: true, record: false, review: false, approve: false}})}; expect(await render().start([experienceId], 'model-chat', 3)).toBe(false); expect(projectLearningApi.analyze).not.toHaveBeenCalled();
        props = {...props, data: learningOverview()}; vi.stubGlobal('sessionStorage', {getItem: () => null, setItem: () => {throw new Error('quota');}}); expect(await render().start([experienceId], 'model-chat', 3)).toBe(false); expect(projectLearningApi.analyze).not.toHaveBeenCalled();
    });
    it('Recovery rechecks storage after the user restores access, without generating', async () => {
        vi.stubGlobal('sessionStorage', {getItem: () => {throw new Error('blocked');}}); render(); expect(render().unconfirmed).toBe(true);
        vi.stubGlobal('sessionStorage', {getItem: () => null}); await render().recover(); expect(render().unconfirmed).toBe(false);
        expect(projectLearningApi.analyze).not.toHaveBeenCalled(); expect(projectLearningApi.analysisReceipt).not.toHaveBeenCalled();
    });
});
