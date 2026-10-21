import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useProjectLearning} from '../src/features/ProjectLearning/useProjectLearning';
import {projectLearningApi} from '../src/features/ProjectLearning/api';
import {experience, learningOverview, learningProject} from './project-learning-fixtures';
import {flushLearning, learningDeferred, learningHooks} from './project-learning-hooks';

const hooks = vi.hoisted(() => ({current: undefined as ReturnType<typeof learningHooks> | undefined}));
const ui = vi.hoisted(() => ({scope: 'admin', captures: new Map<string, () => () => boolean>()}));
vi.mock('react', () => ({useState: (...args: Parameters<ReturnType<typeof learningHooks>['useState']>) => hooks.current!.useState(...args), useRef: (...args: Parameters<ReturnType<typeof learningHooks>['useRef']>) => hooks.current!.useRef(...args), useEffect: (...args: Parameters<ReturnType<typeof learningHooks>['useEffect']>) => hooks.current!.useEffect(...args), useCallback: (...args: Parameters<ReturnType<typeof learningHooks>['useCallback']>) => hooks.current!.useCallback(...args)}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    const scope = ui.scope; if (!ui.captures.has(scope)) ui.captures.set(scope, () => () => scope === ui.scope); return {scope, captureOwner: ui.captures.get(scope)!};
}}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('../src/features/ProjectLearning/api', () => ({projectLearningApi: {read: vi.fn(), page: vi.fn()}}));
let projectId: string;
function render() {hooks.current!.begin(); const value = useProjectLearning(projectId); hooks.current!.commit(); return value;}
beforeEach(() => {vi.clearAllMocks(); hooks.current = learningHooks(); ui.scope = 'admin'; ui.captures.clear(); projectId = learningProject; vi.mocked(projectLearningApi.read).mockResolvedValue(learningOverview());});
afterEach(() => hooks.current?.dispose());

describe('Learning project/auth scope and pagination races', () => {
    it('Loads only authorized schema-bound overview and retains old data for a temporary refresh error', async () => {
        render(); await flushLearning(); expect(render().data?.projectId).toBe(learningProject);
        vi.mocked(projectLearningApi.read).mockRejectedValue(new Error('offline')); await render().refresh(); expect(render().data?.experiences).toHaveLength(1); expect(render().error).toBe('offline');
    });
    it.each([401, 403, 404])('Status%s removes old evidence immediately after a denied refresh', async status => {
        render(); await flushLearning(); vi.mocked(projectLearningApi.read).mockRejectedValue({response: {status}}); await render().refresh(); expect(render().data).toBeNull(); expect(render().denied).toBe(true);
    });
    it('Changing identity hides old evidence synchronously before effects finish', async () => {
        render(); await flushLearning(); expect(render().data).not.toBeNull(); ui.scope = 'reader'; expect(render().data).toBeNull();
    });
    it('A late previous-project GET cannot overwrite the current project', async () => {
        const first = learningDeferred<ReturnType<typeof learningOverview>>(); vi.mocked(projectLearningApi.read).mockReturnValueOnce(first.promise); render();
        projectId = 'other'; vi.mocked(projectLearningApi.read).mockResolvedValue(learningOverview({projectId: 'other', experiences: [], hypotheses: [], candidates: []})); render(); await flushLearning();
        first.resolve(learningOverview()); await flushLearning(); expect(render().data?.projectId).toBe('other');
    });
    it('Loads the exact next cursor, deduplicates overlap and preserves active context', async () => {
        const initial = learningOverview({pages: {...learningOverview().pages, experiences: {nextCursor: 'cursor-one', total: 2}}}); vi.mocked(projectLearningApi.read).mockResolvedValue(initial); render(); await flushLearning();
        const older = experience({id: '77777777-7777-4777-8777-777777777777'}); vi.mocked(projectLearningApi.page).mockResolvedValue({items: [experience(), older], nextCursor: null, total: 2}); await render().loadMore('experiences');
        expect(projectLearningApi.page).toHaveBeenCalledExactlyOnceWith(learningProject, 'experiences', 'cursor-one'); expect(render().data?.experiences).toHaveLength(2); expect(render().data?.pages.experiences.nextCursor).toBeNull();
    });
    it('A refresh supersedes a pending older-page response and releases its load lock', async () => {
        const initial = learningOverview({pages: {...learningOverview().pages, experiences: {nextCursor: 'cursor', total: 2}}}); vi.mocked(projectLearningApi.read).mockResolvedValue(initial); render(); await flushLearning();
        const pending = learningDeferred<{items: unknown[]; nextCursor: string | null; total: number}>(); vi.mocked(projectLearningApi.page).mockReturnValueOnce(pending.promise); const older = render().loadMore('experiences');
        await render().refresh(); pending.resolve({items: [experience({title: 'stale page'})], nextCursor: null, total: 2}); await older;
        expect(render().data?.experiences[0].title).not.toBe('stale page'); expect(render().loadingMore).toBeNull();
    });
});
