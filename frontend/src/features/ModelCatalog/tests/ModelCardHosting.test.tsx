// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ModelCard } from '../ModelCard';
import { useModelCatalog } from '../hooks/useModelCatalog';
import { modelChatUnavailableReason } from '../../ModelChat/model';
import type { ICatalogModel } from '../interfaces';
import { stubModalBrowser } from './browser.fixture';
const io = vi.hoisted(() => ({ list: vi.fn(), hosting: vi.fn() }));
vi.mock('../api', () => ({ modelCatalogApi: io }));
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({ useSectionUpdates: () => undefined }));
vi.mock('../../UserBlock/hooks/useAuthRequestOwner', () => {
    const captureOwner = () => () => true;
    return { useAuthRequestOwner: () => ({ captureOwner }) };
});
vi.mock('../../FeatureFlags/FeatureAvailability', async () => {
    const { Button } = await import('antd');
    return {
        FeatureButton: ({ features: _features, ...props }: import('antd').ButtonProps & { features: string[] }) => (
            <Button {...props} />
        ),
    };
});
const model: ICatalogModel = {
    id: 'remote',
    name: 'QA remote',
    description: '',
    capability: 'chat',
    runtime: 'remote-ollama',
    model: 'qa',
    manifestSha256: null,
    verificationSha256: null,
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
};
/** Real catalog and hosting owners must converge without socket events or a page reload. */
it.each([true, false])(
    'refreshes chat eligibility from the catalog after check completion (verified=%s)',
    async (catalogVerified) => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        stubModalBrowser();
        vi.useFakeTimers();
        let verified = false;
        io.list.mockImplementation(async () => ({
            items: [{ ...model, verificationSha256: verified && catalogVerified ? 'a'.repeat(64) : null }],
            assignedModelIds: ['remote'],
        }));
        io.hosting.mockImplementation(async () => ({
            state: verified ? 'ready' : 'busy',
            message: '',
            checkedAt: verified ? '2026-11-01T00:00:00Z' : null,
        }));
        function Catalog() {
            const { catalog, refresh } = useModelCatalog('project');
            const item = catalog?.items[0];
            return item ? (
                <ModelCard
                    model={item}
                    assigned
                    projectSelected
                    canAssign={false}
                    canHost={false}
                    busy={false}
                    onAssign={() => undefined}
                    onView={() => undefined}
                    onChat={() => undefined}
                    onHostingSettled={refresh}
                    chatUnavailableReason={modelChatUnavailableReason(item, true, true, true)}
                />
            ) : null;
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            await act(async () => root.render(<Catalog />));
            const chat = () => container.querySelector('[aria-label="Чат с моделью QA remote"]') as HTMLButtonElement;
            expect(chat().disabled).toBe(true);
            verified = true;
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });
            expect(container.textContent).toContain('Готова');
            expect(chat().disabled).toBe(!catalogVerified);
            expect(io.list).toHaveBeenCalledTimes(2);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(6000);
            });
            expect(io.list).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => root.unmount());
            vi.useRealTimers();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    },
);
