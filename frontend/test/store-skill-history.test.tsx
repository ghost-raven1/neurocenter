// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import StoreDetailsModal from '../src/modules/Store/StoreDetailsModal';
import type {ISkillFile} from '../src/core/api/interfaces';
import type {IStoreApp} from '../src/features/Catalog/types';

const h = vi.hoisted(() => ({scope: 'owner-one', enabled: false, live: () => {}, edit: vi.fn(), install: vi.fn()}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    const scope = h.scope; return {scope, captureOwner: () => () => scope === h.scope};
}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({FeatureButton: ({children, disabled, onClick}: any) => createElement('button', {disabled: disabled || !h.enabled, onClick}, children)}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn()}}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: (_sections: unknown, refresh: () => void) => {h.live = refresh;}}));
vi.mock('../src/modules/Store/AppCard', () => ({KindBadge: () => null}));
vi.mock('../src/modules/Store/StoreDetailsInstall', () => ({default: () => null, StoreDetailsInstallButton: ({onInstall, disabled}: any) => createElement('button', {onClick: onInstall, disabled}, 'Установить head')}));
vi.mock('antd', async original => {
    const actual = await original<typeof import('antd')>();
    return {...actual, Grid: {useBreakpoint: () => ({sm: true})}, Modal: ({children, footer}: any) => createElement('section', null, children, footer)};
});
import api from '../src/core/api/base';

const firstHistory = {version: 1, at: '2026-10-28T00:00:00Z', author: 'owner-one', note: 'Initial version'};
const head = {path: 'common/qa-history', body: '# Current instruction v2', resources: [], meta: {generation: 'generation-one', name: 'Own QA skill', slug: 'qa-history', scope: 'common',
    version: 2, owner: 'owner-one', updatedAt: '2026-10-28T00:00:01Z', mcp: [], plugins: [], tags: [], history: [firstHistory, {version: 2, at: '2026-10-28T00:00:01Z', author: 'owner-one', note: 'Updated version'}]}} as ISkillFile;
const old = {...head, body: '# Historical instruction v1\n[Old reference](references/guide.md)', resources: [{path: 'references/guide.md', content: 'Historical resource v1'}], meta: {...head.meta, version: 1, history: [firstHistory]}};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
let root: Root, container: HTMLDivElement, app: IStoreApp;
const settle = async () => {await act(async () => {await new Promise(done => setTimeout(done, 5));});};
const render = async (projectId = 'project-one') => {
    await act(async () => root.render(createElement(StoreDetailsModal, {viewApp: app, onClose: vi.fn(), onEdit: h.edit, onInstall: h.install, projectId}))); await settle();
};
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label);
const click = async (node: HTMLElement | undefined) => {expect(node).toBeTruthy(); await act(async () => node!.click()); await settle();};
const versions = async () => click([...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(node => node.textContent === 'Версии'));
beforeEach(() => {
    vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.scope = 'owner-one'; h.enabled = false;
    vi.stubGlobal('matchMedia', (media: string) => ({matches: false, media, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    Element.prototype.scrollIntoView = vi.fn();
    app = {id: head.path, path: head.path, kind: 'skill', name: head.meta.name, version: 2, description: '', origin: '', tags: []};
    vi.mocked(api.get).mockResolvedValue({data: head}); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('opens exact v1 body and resources from v2 history while preserving current head actions and OFF reads', async () => {
    await render(); await versions(); expect(api.get).toHaveBeenCalledOnce();
    vi.mocked(api.get).mockResolvedValue({data: old}); await click(button('Открыть версию 1'));
    expect(api.get).toHaveBeenLastCalledWith('/api/skills/' + head.path, {params: {version: 1}});
    expect(container.textContent).toContain('Версия 1 · Только чтение'); expect(container.textContent).toContain('Historical instruction v1');
    await click(container.querySelector<HTMLElement>('[aria-label="Открыть references/guide.md"]')!);
    expect(container.textContent).toContain('Historical resource v1');
    await click(button('Установить head')); expect(h.install).toHaveBeenCalledExactlyOnceWith(2); expect(button('Редактировать')!.disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
});

it('keeps head editing and installation on v2 after viewing v1, and exposes the exact old source', async () => {
    h.enabled = true; await render(); await versions(); vi.mocked(api.get).mockResolvedValue({data: old}); await click(button('Открыть версию 1'));
    expect(container.querySelector('.store-skill-version pre')!.textContent).toBe(old.body);
    await click(button('Редактировать')); await click(button('Установить head'));
    expect(h.edit).toHaveBeenCalledOnce(); expect(h.install).toHaveBeenCalledExactlyOnceWith(2);
    await click(button('Закрыть версию')); expect(container.querySelector('.store-skill-version')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(2); expect(api.put).not.toHaveBeenCalled();
});

it.each([401, 403, 404])('keeps a historical HTTP%s error explicit without displaying the head as that version', async status => {
    await render(); await versions(); vi.mocked(api.get).mockRejectedValueOnce({isAxiosError: true, response: {status, data: {message: status === 404 ? 'Содержимое старой версии не сохранено.' : 'Доступ отозван.'}}});
    await click(button('Открыть версию 1')); const viewer = container.querySelector('.store-skill-version')!;
    expect(viewer.textContent).toContain(status === 404 ? 'Содержимое старой версии не сохранено.' : 'Доступ отозван.');
    expect(viewer.textContent).not.toContain('Current instruction v2'); expect(viewer.querySelector('pre')).toBeNull();
    vi.mocked(api.get).mockResolvedValue({data: old}); await click(button('Повторить чтение'));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Historical instruction v1');
    expect(api.get).toHaveBeenLastCalledWith('/api/skills/' + head.path, {params: {version: 1}}); expect(api.post).not.toHaveBeenCalled();
});

it.each(['path', 'version', 'generation'] as const)('rejects a historical response with a different %s instead of substituting it', async mismatch => {
    await render(); await versions(); const bad = {...old, ...(mismatch === 'path' ? {path: 'common/other'} : {}),
        meta: {...old.meta, ...(mismatch === 'version' ? {version: 2} : mismatch === 'generation' ? {generation: 'recreated-skill'} : {})}};
    vi.mocked(api.get).mockResolvedValue({data: bad}); await click(button('Открыть версию 1'));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Скилл или его версия изменились');
    expect(container.querySelector('.store-skill-version pre')).toBeNull(); expect(api.put).not.toHaveBeenCalled();
});

it('does not let a late v1 response replace a subsequently selected v2', async () => {
    await render(); await versions(); const pending = deferred<{data: ISkillFile}>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise);
    await click(button('Открыть версию 1')); expect(container.querySelector('.store-skill-version [role="status"]')).toBeTruthy();
    vi.mocked(api.get).mockResolvedValue({data: head}); await click(button('Открыть версию 2'));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Current instruction v2');
    await act(async () => pending.resolve({data: old}));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Версия 2 · Только чтение');
    expect(container.querySelector('.store-skill-version')!.textContent).not.toContain('Historical instruction v1'); expect(api.post).not.toHaveBeenCalled();
});

it.each(['actor', 'rights'] as const)('discards historical responses across %s ABA while fresh authorized reads stay independent', async change => {
    await render(); await versions(); const pending = deferred<{data: ISkillFile}>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise); await click(button('Открыть версию 1'));
    const current = {...old, body: '# Fresh authorized response'}; vi.mocked(api.get).mockResolvedValue({data: current});
    h.scope = change + '-changed'; await render(); h.scope = 'owner-one'; await render();
    await act(async () => pending.resolve({data: old}));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Fresh authorized response');
    expect(container.querySelector('.store-skill-version')!.textContent).not.toContain('Historical instruction v1'); expect(api.post).not.toHaveBeenCalled();
});

it('clears the selected historical payload on project change, even when the skill and visible project names match', async () => {
    await render(); await versions(); const pending = deferred<{data: ISkillFile}>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise); await click(button('Открыть версию 1'));
    const reads = vi.mocked(api.get).mock.calls.length; await render('project-two');
    await act(async () => pending.resolve({data: old}));
    expect(container.querySelector('.store-skill-version')).toBeNull(); expect(api.get).toHaveBeenCalledTimes(reads); expect(api.post).not.toHaveBeenCalled();
});

it.each(['path', 'generation'] as const)('cannot restore a selected old payload after the %s context changes and returns', async change => {
    await render(); await versions(); const pending = deferred<{data: ISkillFile}>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise); await click(button('Открыть версию 1'));
    const next = {...head, ...(change === 'path' ? {path: 'project-project-two/other'} : {}), meta: {...head.meta, ...(change === 'generation' ? {generation: 'generation-two'} : {})}};
    vi.mocked(api.get).mockResolvedValue({data: next});
    if (change === 'path') {app = {...app, id: next.path, path: next.path}; await render(); await versions();}
    else {await act(async () => h.live()); await settle();}
    expect(container.querySelector('.store-skill-version')).toBeNull();
    vi.mocked(api.get).mockResolvedValue({data: head});
    if (change === 'path') {app = {...app, id: head.path, path: head.path}; await render(); await versions();}
    else {await act(async () => h.live()); await settle();}
    await act(async () => pending.resolve({data: old}));
    expect(container.querySelector('.store-skill-version')?.textContent ?? '').not.toContain('Historical instruction v1');
    expect(api.put).not.toHaveBeenCalled();
});

it('binds legacy historical content to its first history entry and refuses a recreated legacy generation', async () => {
    const legacyHead = {...head, meta: {...head.meta, generation: undefined}}; vi.mocked(api.get).mockResolvedValue({data: legacyHead});
    await render(); await versions(); const legacyOld = {...old, meta: {...old.meta, generation: undefined}};
    vi.mocked(api.get).mockResolvedValueOnce({data: legacyOld}); await click(button('Открыть версию 1'));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Historical instruction v1');
    await click(button('Закрыть версию'));
    vi.mocked(api.get).mockResolvedValue({data: {...legacyOld, meta: {...legacyOld.meta, history: [{...firstHistory, at: '2026-10-28T01:00:00Z'}]}}});
    await click(button('Открыть версию 1')); expect(container.querySelector('.store-skill-version')!.textContent).toContain('Скилл или его версия изменились');
    expect(container.querySelector('.store-skill-version pre')).toBeNull();
});

it('renders old instruction HTML as text/source and only opens resources delivered with that historical version', async () => {
    await render(); await versions(); const hostile = '<script>alert(1)</script>\n[Missing](references/current.md)';
    vi.mocked(api.get).mockResolvedValue({data: {...old, body: hostile}}); await click(button('Открыть версию 1'));
    const viewer = container.querySelector('.store-skill-version')!;
    expect(viewer.querySelector('script, iframe, img')).toBeNull(); expect(viewer.querySelector('pre')!.textContent).toBe(hostile);
    expect(viewer.querySelector('[aria-label="Открыть references/current.md"]')).toBeNull();
    await click([...viewer.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.textContent?.startsWith('Файлы скилла')));
    await click(viewer.querySelector<HTMLElement>('[aria-label="Просмотреть файл references/guide.md"]')!);
    expect(viewer.textContent).toContain('Historical resource v1'); expect(api.get).toHaveBeenCalledTimes(2);
});

it('restores history after remount through the same explicit version read without a mutation', async () => {
    await render(); await versions(); vi.mocked(api.get).mockResolvedValueOnce({data: old}); await click(button('Открыть версию 1'));
    await act(async () => root.unmount()); root = createRoot(container); vi.mocked(api.get).mockResolvedValue({data: head}); await render(); await versions();
    expect(container.querySelector('.store-skill-version')).toBeNull(); vi.mocked(api.get).mockResolvedValue({data: old}); await click(button('Открыть версию 1'));
    expect(container.querySelector('.store-skill-version')!.textContent).toContain('Historical instruction v1'); expect(api.put).not.toHaveBeenCalled();
});
