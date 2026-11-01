// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBundledBuildRetry } from '../useBundledBuildRetry';
import { useToolBuild } from '../../../../modules/Store/packaging/hooks/useToolBuild';
import { usePackagingPublication } from '../../../../modules/Store/packaging/hooks/usePackagingPublication';
import type { IBundledSourcePlan } from '../../interfaces';
import type { IToolBuild, IToolBuildRequest } from '../../../../modules/Store/packaging/interfaces';

const io = vi.hoisted(() => ({
    get: vi.fn(),
    create: vi.fn(),
    lookup: vi.fn(),
    publicationTarget: vi.fn(),
    read: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
    prepared: vi.fn(),
}));
vi.mock('../../../../modules/Store/packaging/api', () => ({ packagingApi: io }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ key: 'test' }) }));
vi.mock('../../../../modules/Store/packaging/hooks/buildDraftStore', () => ({
    readStoredBuildRecovery: io.read,
    listStoredBuildArchives: vi.fn(async () => []),
    saveStoredBuildDraft: io.save,
    clearStoredBuildDraft: io.clear,
}));
const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const nextKey = '33333333-3333-4333-8333-333333333333';
const plan: IBundledSourcePlan = {
    id: 'mcp-recipe',
    revision: 'a'.repeat(64),
    sourceRevision: 'git-old',
    kind: 'mcp',
    name: 'Recipe',
    description: 'Description',
    delivery: 'prepared',
};
const job: IToolBuild = {
    id,
    requestKey: key,
    operationId: `tool-build-${id}`,
    publicationStartedAt: null,
    state: 'FAILED',
    percent: 40,
    message: 'Failed',
    recovery: {
        source: { type: 'bundled', id: plan.id, revision: plan.revision },
        targets: ['linux-x64-glibc'],
        kind: 'mcp',
        name: 'Original',
        description: 'Original description',
        tags: ['original'],
    },
};
let owned = true;
const captureOwner = () => () => owned;
let root: Root;
let container: HTMLDivElement;
let view: {
    retry: ReturnType<typeof useBundledBuildRetry>;
    build: ReturnType<typeof useToolBuild>;
    publication: ReturnType<typeof usePackagingPublication>;
};
function Probe({
    enabled = true,
    plans = [plan],
    scope = 'owner',
}: {
    enabled?: boolean;
    plans?: IBundledSourcePlan[];
    scope?: string;
}): null {
    const build = useToolBuild(scope);
    const publication = usePackagingPublication(scope, captureOwner);
    const retry = useBundledBuildRetry({
        scope,
        recoverBuildId: id,
        prepareId: plan.id,
        captureOwner,
        plans,
        blocked: false,
        enabled,
        build,
        publication,
        onPrepared: io.prepared,
    });
    view = { retry, build, publication };
    return null;
}
async function render(props: Parameters<typeof Probe>[0] = {}): Promise<void> {
    await act(async () => {
        root.render(<Probe {...props} />);
    });
}
beforeEach(() => {
    vi.clearAllMocks();
    owned = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(nextKey);
    localStorage.clear();
    window.history.replaceState({}, '');
    io.get.mockResolvedValue(job);
    io.read.mockResolvedValue({});
    io.clear.mockResolvedValue(true);
    io.save.mockImplementation(async (scope: string, request: IToolBuildRequest) => ({
        schemaVersion: 1,
        scope,
        request,
    }));
    io.create.mockImplementation(async (request: IToolBuildRequest) => ({
        ...job,
        id: nextKey,
        requestKey: request.requestKey,
        state: 'SUCCEEDED',
    }));
    io.lookup.mockResolvedValue(job);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
it('opens read-only, restores pinned inputs, and submits only the explicit new request', async () => {
    await render();
    expect(view.retry.recovery.job?.id).toBe(id);
    expect(io.create).not.toHaveBeenCalled();
    expect(io.save).not.toHaveBeenCalled();
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(io.prepared).toHaveBeenCalledWith(job.recovery, plan);
    expect(io.create).not.toHaveBeenCalled();
    await act(async () => {
        if (await view.retry.validateRetry()) {
            const { publication: _publication, ...body } = view.retry.retrySource!;
            await view.build.submit(body);
        }
    });
    expect(io.create).toHaveBeenCalledOnce();
    expect(io.create).toHaveBeenCalledWith(
        expect.objectContaining({
            requestKey: nextKey,
            source: job.recovery!.source,
            targets: ['linux-x64-glibc'],
            name: 'Original',
            tags: ['original'],
        }),
    );
});
it('does not overwrite another retained request', async () => {
    const request = { ...job.recovery!, publication: undefined, requestKey: nextKey };
    io.read.mockResolvedValue({ draft: { schemaVersion: 1, scope: 'owner', request } });
    io.lookup.mockResolvedValue({ ...job, id: nextKey, requestKey: nextKey });
    await render();
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(view.retry.recoveryConflict).toBe(true);
    expect(io.clear).not.toHaveBeenCalled();
    expect(io.prepared).not.toHaveBeenCalled();
    expect(io.create).not.toHaveBeenCalled();
});
it('does not substitute the current revision for a missing pinned revision', async () => {
    await render({ plans: [{ ...plan, revision: 'new' }] });
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(io.prepared).not.toHaveBeenCalled();
    expect(io.create).not.toHaveBeenCalled();
    expect(view.retry.error).toContain('закреплённого рецепта');
});
it('keeps history available with flags off and rejects a late response after owner revocation', async () => {
    await render({ enabled: false });
    expect(view.retry.recovery.job?.id).toBe(id);
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(io.prepared).not.toHaveBeenCalled();
    await render();
    let resolve!: (value: IToolBuild) => void;
    io.get.mockImplementationOnce(
        () =>
            new Promise<IToolBuild>((done) => {
                resolve = done;
            }),
    );
    let pending!: Promise<void>;
    await act(async () => {
        pending = view.retry.prepareRetry();
    });
    owned = false;
    await act(async () => {
        resolve(job);
        await pending;
    });
    expect(io.prepared).not.toHaveBeenCalled();
    expect(io.create).not.toHaveBeenCalled();
});
it('rechecks terminal state before submit and requires fresh consent for the original update target', async () => {
    io.get.mockResolvedValue({
        ...job,
        recovery: { ...job.recovery!, publication: { mode: 'replace', catalogId: 'original-target' } },
    });
    io.publicationTarget.mockResolvedValue({
        catalogId: 'original-target',
        kind: 'mcp',
        name: 'Current name',
        updateSupported: true,
        expectedVersion: 8,
        expectedSourceHash: 'fresh',
    });
    await render();
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(io.publicationTarget).toHaveBeenCalledWith(
        { catalogId: 'original-target', kind: 'mcp' },
        expect.any(AbortSignal),
    );
    expect(view.publication.blocked).toBe(true);
    expect(view.publication.selection).toBeUndefined();
    await act(async () => {
        view.publication.confirm();
    });
    expect(view.publication.selection?.expectedVersion).toBe(8);
    io.get.mockResolvedValue({ ...job, state: 'SUCCEEDED' });
    let accepted = true;
    await act(async () => {
        accepted = await view.retry.validateRetry();
    });
    expect(accepted).toBe(false);
    expect(io.create).not.toHaveBeenCalled();
});
it('reuses the saved key after an unknown POST outcome instead of creating a second build', async () => {
    vi.useFakeTimers();
    try {
        await render();
        await act(async () => {
            await view.retry.prepareRetry();
        });
        io.create.mockRejectedValueOnce(new Error('Connection lost'));
        io.lookup.mockRejectedValue(new Error('Unavailable'));
        await act(async () => {
            const { publication: _publication, ...body } = view.retry.retrySource!;
            await view.build.submit(body);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(46_000);
        });
        expect(view.build.unresolved).toBe(true);
        await act(async () => {
            await view.build.retrySaved();
        });
        expect(io.create).toHaveBeenCalledTimes(2);
        expect(io.create.mock.calls[0][0].requestKey).toBe(nextKey);
        expect(io.create.mock.calls[1][0]).toEqual(io.create.mock.calls[0][0]);
    } finally {
        vi.useRealTimers();
    }
});
it('discards the earlier read when the context changes before it returns', async () => {
    let resolve!: (value: IToolBuild) => void;
    io.get.mockImplementationOnce(
        () =>
            new Promise<IToolBuild>((done) => {
                resolve = done;
            }),
    );
    await render();
    await render({ scope: 'other-owner' });
    await act(async () => {
        resolve({ ...job, recovery: { ...job.recovery!, name: 'Stale owner' } });
    });
    expect(view.retry.recovery.job?.recovery?.name).toBe('Original');
    expect(io.create).not.toHaveBeenCalled();
});
it('reopens the matching journal and clears it only on explicit terminal retry preparation', async () => {
    const request = { ...job.recovery!, publication: undefined, requestKey: key };
    io.read.mockResolvedValue({ draft: { schemaVersion: 1, scope: 'owner', request } });
    await render();
    expect(io.clear).not.toHaveBeenCalled();
    expect(view.retry.recoveryConflict).toBe(false);
    await act(async () => {
        await view.retry.prepareRetry();
    });
    expect(io.clear).toHaveBeenCalledWith('owner', key);
    expect(io.prepared).toHaveBeenCalledWith(job.recovery, plan);
    expect(io.create).not.toHaveBeenCalled();
});
it('does not submit if the feature is disabled during the final status read', async () => {
    await render();
    await act(async () => {
        await view.retry.prepareRetry();
    });
    let resolve!: (value: IToolBuild) => void;
    io.get.mockImplementationOnce(
        () =>
            new Promise<IToolBuild>((done) => {
                resolve = done;
            }),
    );
    let validation!: Promise<boolean>;
    await act(async () => {
        validation = view.retry.validateRetry();
    });
    await render({ enabled: false });
    let accepted = true;
    await act(async () => {
        resolve(job);
        accepted = await validation;
    });
    expect(accepted).toBe(false);
    expect(io.create).not.toHaveBeenCalled();
});
