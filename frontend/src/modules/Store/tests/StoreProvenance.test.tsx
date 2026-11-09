// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBundlePackage, IAiPlugin, IAiPluginVersion } from '../../../core/api/interfaces';
import { buildProvenance } from '../storeProvenance';
import StoreDetailsModal from '../StoreDetailsModal';
import { stubModalBrowser } from '../../../features/ModelCatalog/tests/browser.fixture';

const bffMock = vi.hoisted(() => ({
    getAiPlugin: vi.fn(),
    listAiPluginVersions: vi.fn(),
    getAiPluginPackage: vi.fn(),
}));
const sectionUpdatesMock = vi.hoisted(() => vi.fn());
vi.mock('../../../core/api/bff', () => ({ default: bffMock }));
vi.mock('../../../core/socket/hooks/useSectionUpdates', () => ({
    useSectionUpdates: (...args: unknown[]) => sectionUpdatesMock(...args),
}));
vi.mock('react-redux', () => ({
    useSelector: (select: (state: unknown) => unknown) =>
        select({ userBlock: { user: { id: 'owner', principalName: 'owner', activeRole: 'Главный админ' }, policies: [] } }),
    useStore: () => ({ getState: () => ({ userBlock: { user: null, policies: [] } }) }),
}));
vi.mock('../../../features/FeatureFlags/FeatureAvailability', () => ({
    useFeatureAvailability: () => ({ enabled: true, known: true }),
    FeatureButton: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
        <button {...props}>{children}</button>
    ),
}));

const SHA = 'a'.repeat(64);
const plugin: IAiPlugin = {
    id: 'ai-plug-qa-prov',
    name: 'QA Provenance',
    kind: 'plugin',
    description: 'UJ-2 QA',
    version: 1,
    compatibility: null,
    tags: [],
    origin: 'https://github.com/qa/provenance-repo',
    revision: 'v1.4.2',
    config: { entrypoint: 'index.js' },
    files: [{ path: 'index.js', size: 20, digest: 'b'.repeat(64), content: 'module.exports = 1;' }],
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
};
const versionRow: IAiPluginVersion = {
    version: 1,
    files: plugin.files,
    author: 'publisher@example.test',
    note: 'Первая публикация',
    createdAt: '2026-11-02T09:30:00.000Z',
    metadata: { origin: 'https://github.com/qa/provenance-repo', revision: 'v1.4.2' },
};
const pkg: IBundlePackage = {
    schemaVersion: 4,
    config: { entrypoint: 'index.js' },
    plugin: { id: plugin.id, name: plugin.name, kind: 'plugin', version: 1 },
    files: [{ path: 'index.js', size: 20, sha256: 'c'.repeat(64), content: 'module.exports = 1;' }],
    manifest: { sha256: SHA, createdAt: '2026-11-02T09:30:00.000Z', filesCount: 1 },
};

describe('buildProvenance (FR-203: 5 полей провенанса)', () => {
    it('собирает версию, SHA, источник, время и издателя', () => {
        const provenance = buildProvenance(versionRow, pkg, {}, 1);
        expect(provenance).toEqual({
            version: 1,
            sha256: SHA,
            origin: 'https://github.com/qa/provenance-repo',
            revision: 'v1.4.2',
            createdAt: '2026-11-02T09:30:00.000Z',
            author: 'publisher@example.test',
        });
    });

    it('берёт envelope из метаданных версии, а не из head-карточки', () => {
        const old = { ...versionRow, metadata: { origin: 'https://www.npmjs.com/package/qa-npm-tool', revision: 'v0.1.0' } };
        const provenance = buildProvenance(old, pkg, { origin: plugin.origin, revision: plugin.revision });
        expect(provenance.origin).toBe('https://www.npmjs.com/package/qa-npm-tool');
        expect(provenance.revision).toBe('v0.1.0');
    });

    it('использует fallback карточки для старых версий без envelope', () => {
        const bare: IAiPluginVersion = { ...versionRow, metadata: undefined };
        const provenance = buildProvenance(bare, pkg, { origin: plugin.origin, revision: plugin.revision });
        expect(provenance.origin).toBe(plugin.origin);
        expect(provenance.revision).toBe(plugin.revision);
    });

    it('показывает статус, если поле уже присутствует (entry 7)', () => {
        const retired: IAiPluginVersion = {
            ...versionRow,
            metadata: {
                origin: 'https://github.com/qa/provenance-repo',
                revision: 'v1.4.2',
                status: 'retired',
            } as IAiPluginVersion['metadata'],
        };
        const provenance = buildProvenance(retired, pkg, {}, 1);
        expect(provenance.status).toBe('retired');
    });

    it('отклоняет несогласованную версию или невалидный SHA', () => {
        expect(() => buildProvenance(versionRow, { ...pkg, plugin: { ...pkg.plugin, version: 2 } }, {}, 1)).toThrow();
        expect(() => buildProvenance(versionRow, { ...pkg, manifest: { ...pkg.manifest, sha256: 'xyz' } }, {}, 1)).toThrow();
    });
});

describe('StoreDetailsModal: вкладка «Провенанс»', () => {
    let root: Root;
    let container: HTMLDivElement;
    const flush = async () => {
        await act(async () => {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    };

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        stubModalBrowser();
        bffMock.getAiPlugin.mockReset().mockResolvedValue(plugin);
        bffMock.listAiPluginVersions.mockReset().mockResolvedValue([versionRow]);
        bffMock.getAiPluginPackage.mockReset().mockResolvedValue(pkg);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('показывает 5 полей провенанса активной версии', async () => {
        const viewApp = { ...plugin, name: plugin.name, version: 1 };
        await act(async () => {
            root.render(<StoreDetailsModal viewApp={viewApp} onClose={() => undefined} />);
        });
        await flush();
        // Открываем вкладку «Провенанс».
        const tabs = [...document.body.querySelectorAll('.ant-tabs-tab')];
        const provenanceTab = tabs.find((tab) => tab.textContent?.includes('Провенанс'));
        expect(provenanceTab).toBeTruthy();
        await act(async () => {
            (provenanceTab as HTMLElement).click();
        });
        await flush();
        const body = document.body.textContent ?? '';
        // Секция провенанса открыта.
        expect(document.body.querySelector('[aria-label="Провенанс артефакта"]')).toBeTruthy();
        // Версия.
        expect(body).toContain('Версия');
        // SHA — server-issued manifest.
        expect(body).toContain(SHA);
        // Источник (origin + revision).
        expect(body).toContain('https://github.com/qa/provenance-repo');
        expect(body).toContain('v1.4.2');
        // Издатель.
        expect(body).toContain('publisher@example.test');
        // Оба существующих эндпоинта использованы (без нового API).
        expect(bffMock.listAiPluginVersions).toHaveBeenCalledWith(plugin.id);
        expect(bffMock.getAiPluginPackage).toHaveBeenCalledWith(plugin.id, 1);
    });
});
