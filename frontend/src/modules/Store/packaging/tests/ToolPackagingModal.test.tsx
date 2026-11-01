// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolPackagingModal } from '../ToolPackagingModal';
import { stubModalBrowser } from '../../../../features/ModelCatalog/tests/browser.fixture';
const io = vi.hoisted(() => ({
    read: vi.fn(),
    archive: vi.fn(),
    submit: vi.fn(),
    enabled: true,
    main: true,
    owner: true,
    python: 'failed',
    select: vi.fn(),
}));
vi.mock('../../../../features/AssetSources/hooks/useCatalogSuppliesAccess', () => ({
    useCatalogSuppliesAccess: () => ({ sourcePermission: io.main }),
}));
vi.mock('../sourceFiles', async () => ({
    ...(await vi.importActual<typeof import('../sourceFiles')>('../sourceFiles')),
    readPackagingFiles: io.read,
}));
vi.mock('../sourceArchive', () => ({ readPackagingArchive: io.archive }));
vi.mock('../../../../features/UserBlock/hooks/useAuthRequestOwner', () => {
    const originalOwner = () => () => io.owner;
    const nextOwner = () => () => !io.owner;
    return { useAuthRequestOwner: () => ({ captureOwner: io.owner ? originalOwner : nextOwner }) };
});
vi.mock('../../../../features/FeatureFlags/FeatureAvailability', async () => {
    const { Button } = await import('antd');
    return {
        useFeatureAvailability: () => ({ enabled: io.enabled }),
        FeatureAvailabilityNotice: () => null,
        FeatureButton: ({ features: _features, ...props }: import('antd').ButtonProps & { features: string[] }) => (
            <Button {...props} />
        ),
    };
});
vi.mock('../hooks/useToolBuild', () => ({ useToolBuild: () => ({ submit: io.submit }) }));
vi.mock('../hooks/usePackagingPublication', () => ({ usePackagingPublication: () => ({}) }));
vi.mock('../hooks/useSourceUpload', async () => {
    const { useState } = await import('react');
    return {
        useSourceUpload: () => {
            const [state, setState] = useState({ error: '', intent: undefined as { name: string } | undefined });
            return {
                ...state,
                select: async (file: File) => {
                    io.select(file);
                    setState(
                        io.python === 'failed'
                            ? { error: 'Не удалось сохранить загрузку', intent: undefined }
                            : { error: 'Ответ потерян; проверьте загрузку', intent: { name: file.name } },
                    );
                },
            };
        },
    };
});
vi.mock('../SourceArchiveUploader', () => ({
    SourceArchiveUploader: ({ upload }: { upload: { error: string } }) => (
        <div>Сохранённая загрузка: {upload.error}</div>
    ),
}));
vi.mock('../hooks/useNpmMetadata', () => ({ useNpmMetadata: () => ({}) }));
vi.mock('../hooks/useRepositoryMetadata', () => ({ useRepositoryMetadata: () => ({}) }));
vi.mock('../hooks/usePackagingAgent', () => ({ usePackagingAgent: () => ({}) }));
vi.mock('../hooks/useBuildTargets', () => ({ useBuildTargets: () => ({ value: ['linux-x64'], choose: vi.fn() }) }));
vi.mock('../PackagingPublicationPanel', () => ({ PackagingPublicationPanel: () => null }));
vi.mock('../PackagingAgentOptions', () => ({ PackagingAgentOptions: () => null }));
vi.mock('../BuildTargetChoice', () => ({ BuildTargetChoice: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
    vi.clearAllMocks();
    io.enabled = true;
    io.main = true;
    io.owner = true;
    io.python = 'failed';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubModalBrowser();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    io.read.mockResolvedValue({
        files: [{ path: 'index.js', content: 'export default 1;' }],
        skipped: 0,
        rootName: 'good-source',
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function select() {
    const input = document.querySelector('input[type=file][multiple]:not([webkitdirectory])') as HTMLInputElement;
    expect(input).not.toBeNull();
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['source'], 'index.js')] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
it('keeps the previous successful files and entrypoint after a replacement cannot be read', async () => {
    await act(async () =>
        root.render(
            <ToolPackagingModal
                open
                start={{ source: 'files' }}
                scope="owner"
                onClose={vi.fn()}
                onPublished={vi.fn()}
            />,
        ),
    );
    await select();
    expect(document.body.textContent).toContain('good-source');
    expect(document.body.textContent).toContain('index.js');
    io.read.mockRejectedValue(Error('Лимит 1 МиБ'));
    await select();
    expect(document.body.textContent).toContain('Лимит 1 МиБ');
    expect(document.body.textContent).toContain('good-source');
    expect(document.body.textContent).toContain('index.js');
    expect(io.submit).not.toHaveBeenCalled();
});
async function render() {
    await act(async () =>
        root.render(
            <ToolPackagingModal
                open
                start={{ source: 'files' }}
                scope="owner"
                onClose={vi.fn()}
                onPublished={vi.fn()}
            />,
        ),
    );
}
it.each(['failed', 'durable'])('Python %s handoff keeps the correct recoverable owner', async (mode) => {
    await render();
    await select();
    io.python = mode;
    io.read.mockResolvedValue({ files: [{ path: 'main.py', content: 'print(1)' }], skipped: 0 });
    await select();
    expect(io.select).toHaveBeenCalledTimes(1);
    if (mode === 'failed') {
        expect(document.body.textContent).toContain('good-source');
        expect(document.body.textContent).toContain('Не удалось сохранить загрузку');
    } else {
        expect(document.body.textContent).toContain('Сохранённая загрузка: Ответ потерян');
    }
    expect(io.submit).not.toHaveBeenCalled();
});
it('project admin receives a retry path without forbidden supply links', async () => {
    io.main = false;
    await render();
    await select();
    io.read.mockRejectedValue(Error('Too large'));
    await select();
    expect(document.body.textContent).toContain('обратитесь к главному администратору');
    expect(document.querySelector('a[href="/assets"]')).toBeNull();
    expect(document.querySelector('a[href="/assets?archive=open"]')).toBeNull();
});
it('archive failure preserves archive name and explicit plugin kind; recovery links open separately', async () => {
    await render();
    io.archive.mockResolvedValue({ files: [{ path: 'index.js', content: 'export default 1' }], skipped: 0 });
    const archiveInput = document.querySelector('input[type=file]:not([multiple])') as HTMLInputElement;
    Object.defineProperty(archiveInput, 'files', { configurable: true, value: [new File(['archive'], 'good.zip')] });
    await act(async () => archiveInput.dispatchEvent(new Event('change', { bubbles: true })));
    const details = Array.from(document.querySelectorAll('[role=button]')).find((node) =>
        node.textContent?.includes('Настроить карточку и тип инструмента'),
    )!;
    await act(async () => details.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const plugin = document.querySelector('input[type=radio][value=plugin]') as HTMLInputElement;
    expect(plugin).not.toBeNull();
    await act(async () => plugin.click());
    expect(plugin.checked).toBe(true);
    io.archive.mockRejectedValue(Error('Неправильный архив'));
    Object.defineProperty(archiveInput, 'files', { configurable: true, value: [new File(['bad'], 'bad.zip')] });
    await act(async () => archiveInput.dispatchEvent(new Event('change', { bubbles: true })));
    expect(document.body.textContent).toContain('good.zip');
    expect(plugin.checked).toBe(true);
    expect(document.body.textContent).toContain('index.js');
    for (const link of document.querySelectorAll('a[href^="/assets"]')) {
        expect(link.getAttribute('target')).toBe('_blank');
    }
    expect(document.body.textContent).toContain('описью index.json');
    expect(io.submit).not.toHaveBeenCalled();
});
it('retains the manually selected command when a new file read fails', async () => {
    await render();
    io.read.mockResolvedValue({
        files: [
            { path: 'index.js', content: 'first' },
            { path: 'alternate.js', content: 'second' },
        ],
        skipped: 0,
        rootName: 'two-commands',
    });
    await select();
    const combo = document.querySelector('[role=combobox][aria-label="Файл запуска"]')!;
    await act(async () =>
        combo.closest('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    const option = Array.from(document.querySelectorAll('.ant-select-item-option-content')).find(
        (node) => node.textContent === 'alternate.js',
    )!;
    expect(option).toBeDefined();
    await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(combo.closest('.ant-form-item')?.textContent).toContain('alternate.js');
    io.read.mockRejectedValue(Error('Не удалось прочитать файл'));
    await select();
    expect(document.querySelector('[aria-label="Файл запуска"]')?.closest('.ant-form-item')?.textContent).toContain(
        'alternate.js',
    );
    expect(io.submit).not.toHaveBeenCalled();
});
it('does not show the previous owner Python handoff error after ownership changes in the same scope', async () => {
    await render();
    io.read.mockResolvedValue({ files: [{ path: 'main.py', content: 'print(1)' }], skipped: 0 });
    await select();
    expect(document.body.textContent).toContain('Не удалось сохранить загрузку');
    io.owner = false;
    await render();
    expect(document.body.textContent).not.toContain('Не удалось сохранить загрузку');
});
