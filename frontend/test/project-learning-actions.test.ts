import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useLearningActions} from '../src/features/ProjectLearning/useLearningActions';
import {projectLearningApi} from '../src/features/ProjectLearning/api';
import type {LearningCommand} from '../src/features/ProjectLearning/types';
import {learningOverview, learningProject, learningReceipt, requestKey} from './project-learning-fixtures';
import {learningDeferred, learningHooks} from './project-learning-hooks';

const hooks = vi.hoisted(() => ({current: undefined as ReturnType<typeof learningHooks> | undefined}));
const ui = vi.hoisted(() => ({scope: 'admin'}));
vi.mock('react', () => ({useState: (...args: Parameters<ReturnType<typeof learningHooks>['useState']>) => hooks.current!.useState(...args), useRef: (...args: Parameters<ReturnType<typeof learningHooks>['useRef']>) => hooks.current!.useRef(...args), useEffect: (...args: Parameters<ReturnType<typeof learningHooks>['useEffect']>) => hooks.current!.useEffect(...args)}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const scope = ui.scope; return {scope, captureOwner: () => () => scope === ui.scope};}}));
vi.mock('../src/features/McpBridge/bridgeRequestKey', () => ({createBridgeRequestKey: () => requestKey}));
vi.mock('../src/features/ProjectLearning/api', () => ({projectLearningApi: {mutate: vi.fn(), receipt: vi.fn()}}));
const values = new Map<string, string>(), refresh = vi.fn();
let props: Parameters<typeof useLearningActions>[0];
const command: LearningCommand = {kind: 'experience', value: {title: 'Draft', summary: 'My text', outcome: 'unknown', evidence: []}};
function render() {hooks.current!.begin(); const value = useLearningActions(props); hooks.current!.commit(); return value;}
beforeEach(() => {
    vi.clearAllMocks(); hooks.current = learningHooks(); ui.scope = 'admin'; values.clear();
    vi.stubGlobal('sessionStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key)});
    props = {projectId: learningProject, data: learningOverview(), blocked: false, refresh}; refresh.mockResolvedValue(learningOverview({revision: 4}));
    vi.mocked(projectLearningApi.mutate).mockResolvedValue(learningReceipt()); vi.mocked(projectLearningApi.receipt).mockResolvedValue(null);
});
afterEach(() => {hooks.current?.dispose(); vi.unstubAllGlobals();});

describe('Human learning commands and lost acknowledgement recovery', () => {
    it('Locks double-click and saves the original draft/CAS/key before sending', async () => {
        const pending = learningDeferred<ReturnType<typeof learningReceipt>>(); vi.mocked(projectLearningApi.mutate).mockReturnValue(pending.promise);
        const actions = render(), first = actions.execute(command, 3); await actions.execute(command, 3);
        expect(projectLearningApi.mutate).toHaveBeenCalledOnce(); expect(values.size).toBe(1); expect(render().busy).toBe(true);
        pending.resolve(learningReceipt()); expect(await first).toBe(true); expect(values.size).toBe(0); expect(refresh).toHaveBeenCalledOnce();
    });
    it('Network failure blocks a new intent and replay first checks receipt, then preserves exact original payload', async () => {
        vi.mocked(projectLearningApi.mutate).mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValueOnce(learningReceipt());
        expect(await render().execute(command, 3)).toBe(false); const original = vi.mocked(projectLearningApi.mutate).mock.calls[0][0];
        expect(render().unconfirmed).toBe(true); await render().execute({...command, value: {...command.value, title: 'Changed'}}, 4); expect(projectLearningApi.mutate).toHaveBeenCalledOnce();
        expect(await render().recover(true)).toBe(true); expect(projectLearningApi.receipt).toHaveBeenCalledWith(learningProject, requestKey); expect(vi.mocked(projectLearningApi.mutate).mock.calls[1][0]).toEqual(original);
    });
    it('A found receipt resolves a lost response without a second POST', async () => {
        vi.mocked(projectLearningApi.mutate).mockRejectedValue(new Error('lost')); await render().execute(command, 3);
        vi.mocked(projectLearningApi.receipt).mockResolvedValue(learningReceipt()); expect(await render().recover(true)).toBe(true); expect(projectLearningApi.mutate).toHaveBeenCalledOnce(); expect(render().unconfirmed).toBe(false);
    });
    it('A confirmed write does not show an error when a live update supersedes its refresh', async () => {
        refresh.mockResolvedValue(null); expect(await render().execute(command, 3)).toBe(true);
        expect(render()).toMatchObject({error: '', unconfirmed: false}); expect(values.size).toBe(0);
    });
    it('A null lookup never declares success or sends a write by itself', async () => {
        vi.mocked(projectLearningApi.mutate).mockRejectedValue(new Error('lost')); await render().execute(command, 3); expect(await render().recover(false)).toBe(false);
        expect(projectLearningApi.mutate).toHaveBeenCalledOnce(); expect(render().unconfirmed).toBe(true); expect(values.size).toBe(1);
    });
    it('CAS conflict preserves the editor-owned draft, refreshes state and permits only a fresh explicit operation', async () => {
        vi.mocked(projectLearningApi.mutate).mockRejectedValue({response: {status: 409}}); expect(await render().execute(command, 3)).toBe(false);
        expect(render()).toMatchObject({conflict: true, unconfirmed: false}); expect(refresh).toHaveBeenCalledOnce(); expect(values.size).toBe(0); expect(vi.mocked(projectLearningApi.mutate).mock.calls[0][0].command).toEqual(command);
    });
    it.each(['capability', 'blocked'])('A direct callback cannot bypass %s', async kind => {
        if (kind === 'blocked') props.blocked = true; else props.data = learningOverview({capabilities: {read: true, record: false, review: false, approve: false}});
        expect(await render().execute(command, 3)).toBe(false); expect(projectLearningApi.mutate).not.toHaveBeenCalled(); expect(values.size).toBe(0);
    });
    it.each(['scope', 'project'])('A late %s reply cannot refresh another review surface or clear the durable original', async kind => {
        const pending = learningDeferred<ReturnType<typeof learningReceipt>>(); vi.mocked(projectLearningApi.mutate).mockReturnValue(pending.promise); const result = render().execute(command, 3);
        if (kind === 'scope') ui.scope = 'reader'; else props = {...props, projectId: 'other'}; render(); pending.resolve(learningReceipt()); expect(await result).toBe(false); expect(refresh).not.toHaveBeenCalled(); expect(values.size).toBe(1);
    });
    it('A stale captured callback after changing role cannot submit', async () => {const old = render(); ui.scope = 'other'; expect(await old.execute(command, 3)).toBe(false); expect(projectLearningApi.mutate).not.toHaveBeenCalled();});
    it('A malformed receipt stays unknown rather than closing a form as saved', async () => {
        vi.mocked(projectLearningApi.mutate).mockResolvedValue(learningReceipt({projectId: 'other'})); expect(await render().execute(command, 3)).toBe(false); expect(render().unconfirmed).toBe(true); expect(refresh).not.toHaveBeenCalled();
    });
    it('Unavailable browser storage stops before the HTTP mutation', async () => {
        render(); vi.stubGlobal('sessionStorage', {getItem: () => null, setItem: () => {throw new Error('quota');}});
        expect(await render().execute(command, 3)).toBe(false); expect(projectLearningApi.mutate).not.toHaveBeenCalled(); expect(render().unconfirmed).toBe(false); expect(render().error).toContain('не отправлена');
    });
    it('Recovery rechecks previously unavailable storage and reloads state without sending a write', async () => {
        vi.stubGlobal('sessionStorage', {getItem: () => {throw new Error('blocked');}}); render(); expect(render().unconfirmed).toBe(true);
        vi.stubGlobal('sessionStorage', {getItem: () => null}); expect(await render().recover(false)).toBe(true);
        expect(refresh).toHaveBeenCalledOnce(); expect(projectLearningApi.mutate).not.toHaveBeenCalled(); expect(render().unconfirmed).toBe(false);
    });
    it('A forbidden receipt lookup cannot erase an unresolved original write', async () => {
        vi.mocked(projectLearningApi.mutate).mockRejectedValue(new Error('lost')); await render().execute(command, 3);
        vi.mocked(projectLearningApi.receipt).mockRejectedValue({response: {status: 403}}); expect(await render().recover(false)).toBe(false);
        expect(values.size).toBe(1); expect(render().unconfirmed).toBe(true); expect(projectLearningApi.mutate).toHaveBeenCalledOnce();
    });
});
