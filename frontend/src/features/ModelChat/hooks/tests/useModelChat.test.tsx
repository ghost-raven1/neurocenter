// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useModelChat } from '../useModelChat';
import { useChatContext } from '../useChatContext';
import type { IModelChatDetail } from '../../interfaces';
import type { ICatalogModel } from '../../../ModelCatalog/interfaces';
import type { ITextContext } from '@neurocenter/project-text-knowledge';

const io = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), enabled: true, owner: 'qa' }));
vi.mock('../../../../core/api/base', () => ({ default: { get: io.get, post: io.post } }));
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => {
        const owner = io.owner;
        return () => owner === io.owner;
    };
    return { useAuthRequestOwner: () => ({ scope: io.owner, captureOwner }) };
});
vi.mock('../../../FeatureFlags/FeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: io.enabled, known: true }),
}));
vi.mock('../../../TabNotifications/hooks/useTabWatch', () => ({ useTabWatch: () => undefined }));
vi.mock('../../../TabNotifications/tracker', () => ({ tabNotifications: { expect: vi.fn() } }));
const model = { id: 'model', modelPin: 'a'.repeat(64) } as ICatalogModel;
const detail: IModelChatDetail = {
    conversation: {
        id: 'conversation',
        modelId: 'model',
        projectId: 'project',
        title: 'QA',
        modelPin: 'a'.repeat(64),
        revision: 1,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
    },
    turns: [],
    attachments: [],
    history: { hasMore: false, nextCursor: null },
    compaction: { state: 'none', coveredTurns: 0 },
    context: {
        contextWindowTokens: 4096,
        reservedOutputTokens: 512,
        estimatedInputTokens: 1,
        method: 'estimate',
        messageCount: 0,
        maxMessageBytes: 10000,
        maxRequestBytes: 10000,
        requestBytes: 0,
        exceeded: false,
        canCompact: false,
        compactionNeeded: false,
    },
};
const selection: ITextContext = { mode: 'text', revision: 7, corpusHash: 'b'.repeat(64), query: 'авторизация' };
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
});

it.each(['reload', 'flag off', 'storage failure', 'conflicting tools'])(
    '%s preserves the explicit text request',
    async (scenario) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        io.enabled = true;
        io.owner = 'qa';
        sessionStorage.clear();
        io.get.mockReset();
        io.post.mockReset();
        io.get.mockImplementation(async (path: string) => ({
            data: path === '/api/model-chats' ? { items: [detail.conversation] } : detail,
        }));
        io.post.mockRejectedValue(Error('ACK lost'));
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        let current: ReturnType<typeof useModelChat>;
        function Harness() {
            current = useModelChat(model, 'project', '', { initialDetail: detail, autoSelect: false });
            return <span>{current.error}</span>;
        }
        const show = async (visible: boolean) => {
            await act(async () => root.render(visible ? <Harness /> : null));
        };
        try {
            await show(true);
            if (scenario === 'flag off') io.enabled = false;
            if (scenario === 'storage failure')
                vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                    throw Error('storage');
                });
            if (scenario === 'flag off') await show(true);
            await act(async () => {
                current!.send(
                    'Вопрос',
                    undefined,
                    scenario === 'conflicting tools' ? { protocol: 'json-actions-v1', rag: true } : undefined,
                    undefined,
                    selection,
                );
            });
            if (scenario !== 'reload') {
                expect(io.post).not.toHaveBeenCalled();
                expect(container.textContent).not.toBe('');
                return;
            }
            expect(io.post).toHaveBeenCalledTimes(1);
            const first = io.post.mock.calls[0][1];
            expect(first.textContext).toEqual(selection);
            await show(false);
            await show(true);
            expect(io.post).toHaveBeenCalledTimes(1);
            expect(current!.turns[0].textContext?.selection).toEqual(selection);
            await act(async () => current!.retry());
            expect(io.post).toHaveBeenCalledTimes(2);
            expect(io.post.mock.calls[1][1]).toEqual(first);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    },
);

/** Preview uses the same selection as send, and does not display an old revision's budget. */
it('invalidates a prior text preview when the selected corpus changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    io.owner = 'qa';
    io.enabled = true;
    io.post.mockReset();
    let resolveFirst: (value: unknown) => void = () => undefined;
    io.post
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFirst = resolve;
                }),
        )
        .mockResolvedValue({ data: { ...detail.context, estimatedInputTokens: 22 } });
    const container = document.createElement('div');
    const root = createRoot(container);
    function Harness({ selected }: { selected: ITextContext }) {
        const preview = useChatContext(detail, 'Вопрос', [], true, selected);
        return <span>{preview.context?.estimatedInputTokens ?? 'pending'}</span>;
    }
    try {
        await act(async () => root.render(<Harness selected={selection} />));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 370));
        });
        expect(io.post.mock.calls[0][0]).toContain('/context-preview');
        expect(io.post.mock.calls[0][1].textContext).toEqual(selection);
        const next = { ...selection, revision: 8 };
        await act(async () => root.render(<Harness selected={next} />));
        await act(async () => resolveFirst({ data: { ...detail.context, estimatedInputTokens: 999 } }));
        expect(container.textContent).toBe('pending');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 370));
        });
        expect(io.post.mock.calls[1][1].textContext).toEqual(next);
        expect(container.textContent).toBe('22');
    } finally {
        await act(async () => root.unmount());
    }
});
