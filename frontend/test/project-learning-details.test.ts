import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useLearningHypothesis} from '../src/features/ProjectLearning/useLearningHypothesis';
import {projectLearningApi} from '../src/features/ProjectLearning/api';
import type {LearningHypothesis} from '../src/features/ProjectLearning/types';
import {check, checkId, hypothesis, hypothesisId, learningProject} from './project-learning-fixtures';
import {flushLearning, learningDeferred, learningHooks} from './project-learning-hooks';
const hooks = vi.hoisted(() => ({current: undefined as ReturnType<typeof learningHooks> | undefined}));
const ui = vi.hoisted(() => ({scope: 'admin', captures: new Map<string, () => () => boolean>()}));
vi.mock('react', () => ({useState: (...args: Parameters<ReturnType<typeof learningHooks>['useState']>) => hooks.current!.useState(...args), useRef: (...args: Parameters<ReturnType<typeof learningHooks>['useRef']>) => hooks.current!.useRef(...args), useEffect: (...args: Parameters<ReturnType<typeof learningHooks>['useEffect']>) => hooks.current!.useEffect(...args)}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const scope = ui.scope; if (!ui.captures.has(scope)) ui.captures.set(scope, () => () => scope === ui.scope); return {scope, captureOwner: ui.captures.get(scope)!};}}));
vi.mock('../src/features/ProjectLearning/api', () => ({projectLearningApi: {hypothesis: vi.fn(), check: vi.fn(), checks: vi.fn()}}));
let projectId: string, id: string | undefined, focused: string | undefined, local: LearningHypothesis[];
function render() {hooks.current!.begin(); const value = useLearningHypothesis(projectId, id, local, focused); hooks.current!.commit(); return value;}
beforeEach(() => {vi.clearAllMocks(); hooks.current = learningHooks(); ui.scope = 'admin'; ui.captures.clear(); projectId = learningProject; id = hypothesisId; focused = undefined; local = []; vi.mocked(projectLearningApi.hypothesis).mockResolvedValue(hypothesis());});
afterEach(() => hooks.current?.dispose());

describe('Bounded provenance uses exact older-source lookups', () => {
    it('A local hypothesis does not trigger an unrelated project listing or extra GET', async () => {local = [hypothesis()]; render(); await flushLearning(); expect(render().hypothesis?.id).toBe(hypothesisId); expect(projectLearningApi.hypothesis).not.toHaveBeenCalled();});
    it('An old candidate opens its exact hypothesis when not in latest100', async () => {render(); await flushLearning(); expect(projectLearningApi.hypothesis).toHaveBeenCalledExactlyOnceWith(learningProject, hypothesisId); expect(render().hypothesis?.id).toBe(hypothesisId);});
    it('An older approving check outside latest20 is loaded by its own ID', async () => {
        local = [hypothesis({checks: [], checkCount: 30})]; focused = checkId; vi.mocked(projectLearningApi.check).mockResolvedValue(check()); render(); await flushLearning();
        expect(projectLearningApi.check).toHaveBeenCalledExactlyOnceWith(learningProject, hypothesisId, checkId); expect(render().hypothesis?.checks.map(value => value.id)).toContain(checkId);
    });
    it('Rejects a check from another hypothesis or another project', async () => {
        local = [hypothesis({checks: []})]; focused = checkId; vi.mocked(projectLearningApi.check).mockResolvedValue(check({projectId: 'other'})); render(); await flushLearning(); expect(render().error).toContain('не соответствует'); expect(render().hypothesis?.checks).toHaveLength(0);
    });
    it('A page appends only this hypothesis checks and cannot loop the same cursor forever', async () => {
        const cursor = '77777777-7777-4777-8777-777777777777'; local = [hypothesis({checksNextCursor: cursor, checkCount: 30})]; render(); await flushLearning();
        vi.mocked(projectLearningApi.checks).mockResolvedValue({items: [check()], nextCursor: cursor, total: 30}); await render().loadMore(); expect(render().error).toContain('страница'); expect(render().nextCursor).toBe(cursor);
        vi.mocked(projectLearningApi.checks).mockResolvedValue({items: [check({id: cursor})], nextCursor: null, total: 30}); await render().loadMore(); expect(render().hypothesis?.checks).toHaveLength(2); expect(render().nextCursor).toBeNull();
    });
    it('A stale previous-project lookup cannot replace the current details', async () => {
        const pending = learningDeferred<LearningHypothesis>(); vi.mocked(projectLearningApi.hypothesis).mockReturnValueOnce(pending.promise); render();
        projectId = 'other'; id = undefined; render(); pending.resolve(hypothesis()); await flushLearning(); expect(render().hypothesis).toBeNull();
    });
});
