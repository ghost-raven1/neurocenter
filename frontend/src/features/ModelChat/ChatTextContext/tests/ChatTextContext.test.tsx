// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TEXT_KNOWLEDGE_LIMITS } from '@neurocenter/project-text-knowledge';
import { ChatTextContext } from '../ChatTextContext';
import { useChatTextContext } from '../../hooks/useChatTextContext';
import { stubModalBrowser } from '../../../ModelCatalog/tests/browser.fixture';
const io = vi.hoisted(() => ({
    state: vi.fn(),
    search: vi.fn(),
    limits: vi.fn(),
    upload: vi.fn(),
    enabled: true,
    owner: 'qa',
}));
vi.mock('../../../ProjectTextKnowledge/api', () => ({ projectTextApi: io }));
vi.mock('../../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({
            userBlock: {
                user: {
                    id: 'qa',
                    email: 'qa@example.test',
                    activeRole: 'Главный админ',
                    userRoles: ['Главный админ'],
                    projectRoles: [],
                },
            },
        }),
}));
vi.mock('../../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => {
        const owner = io.owner;
        return () => owner === io.owner;
    };
    return { useAuthRequestOwner: () => ({ scope: io.owner, captureOwner }) };
});
vi.mock('../../../FeatureFlags/hooks/useFeatureAvailability', () => ({
    useFeatureAvailability: () => ({ known: true, enabled: io.enabled, reason: 'Выключено' }),
}));

it.each([false, true])(
    'searches and selects text without sending, preserving draft through conflict=%s and feature OFF',
    async (initialConflict) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        stubModalBrowser();
        localStorage.clear();
        io.enabled = true;
        io.owner = 'qa';
        io.search.mockReset();
        const corpus = {
            mode: 'text',
            projectId: 'project',
            revision: 7,
            corpusHash: 'b'.repeat(64),
            documentCount: 1,
            bytes: 80,
            updatedAt: null,
        };
        io.state.mockResolvedValue(corpus);
        io.limits.mockResolvedValue({ revision: 1, limits: TEXT_KNOWLEDGE_LIMITS });
        io.upload.mockReset();
        io.search.mockRejectedValueOnce(Error('Поиск недоступен')).mockResolvedValue({
            ...corpus,
            sources: [
                {
                    id: 'source',
                    path: 'auth.txt',
                    startLine: 1,
                    endLine: 2,
                    excerpt: 'Авторизация через SSO.',
                    score: 1,
                },
            ],
        });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        function Harness({ projectId }: { projectId: string }) {
            const value = useChatTextContext('model', projectId, 'chat');
            const [open, setOpen] = useState(false);
            const [conflicting, setConflicting] = useState(initialConflict);
            return (
                <ChatTextContext
                    projectId={projectId}
                    value={value}
                    disabled={false}
                    conflicting={conflicting}
                    onUseTextContext={() => setConflicting(false)}
                    open={open}
                    onOpenChange={setOpen}
                />
            );
        }
        const render = async (projectId = 'project') => {
            await act(async () => root.render(<Harness projectId={projectId} />));
        };
        const click = async (label: string) => {
            const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === label);
            expect(button).toBeDefined();
            await act(async () => button!.click());
        };
        try {
            await render();
            await click('Текстовая база проекта');
            expect(io.search).not.toHaveBeenCalled();
            expect(io.upload).not.toHaveBeenCalled();
            const input = document.getElementById('knowledge-query-project') as HTMLInputElement;
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'авторизация');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await click('Найти');
            expect(document.body.textContent).toContain('Поиск недоступен');
            expect(input.value).toBe('авторизация');
            await click('Найти');
            expect(document.body.textContent).toContain('Авторизация через SSO.');
            if (initialConflict) {
                expect(
                    Array.from(document.querySelectorAll('button')).some(
                        (node) => node.textContent === 'Использовать как контекст',
                    ),
                ).toBe(false);
                await click('Перейти к текстовому контексту');
                expect(input.value).toBe('авторизация');
                expect(document.body.textContent).toContain('Авторизация через SSO.');
                expect(io.upload).not.toHaveBeenCalled();
            }
            await click('Использовать как контекст');
            expect(container.textContent).toContain('Текстовый контекст · ревизия 7');
            expect(io.upload).not.toHaveBeenCalled();
            io.enabled = false;
            await render();
            expect(container.textContent).toContain('Выбор сохранён');
            await click('Убрать текстовый контекст');
            expect(container.textContent).not.toContain('Текстовый контекст · ревизия');
            io.enabled = true;
            await click('Текстовая база проекта');
            const nextInput = document.getElementById('knowledge-query-project') as HTMLInputElement;
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
                    nextInput,
                    'авторизация',
                );
                nextInput.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await click('Найти');
            await click('Использовать как контекст');
            await render('other');
            expect(container.textContent).not.toContain('Текстовый контекст · ревизия');
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    },
);
