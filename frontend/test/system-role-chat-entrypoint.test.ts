import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';

const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), owner: 'alice', role: 'Главный админ', service: vi.fn(), team: vi.fn(), personal: vi.fn() };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect }));
vi.mock('react-redux', () => ({ useSelector: () => ({ activeRole: h.role, userRoles: [h.role], projectRoles: [{ projectId: 'prj-one', projectName: 'Проект', role: h.role }] }) }));
vi.mock('react-router-dom', () => ({ useHistory: () => ({ push: vi.fn() }) }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ scope: h.owner, captureOwner: () => () => true }) }));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({ useAvailableProjects: () => ({ projects: [{ id: 'prj-one', name: 'Проект' }], ready: true, loading: false }) }));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({ useModelCatalog: () => ({ catalog: { items: [], assignedModelIds: [] }, loading: false, error: '' }) }));
vi.mock('../src/features/ModelChat/useChatIndex', () => ({ useChatIndex: () => ({ items: [], loading: false, error: '' }) }));
vi.mock('../src/features/ModelChat/ConversationList', () => ({ ConversationList: () => { h.personal(); return null; } }));
vi.mock('../src/features/ModelChat/ChatWorkspace', () => ({ ChatWorkspace: () => null }));
vi.mock('../src/features/ModelChat/api', () => ({ modelChatApi: {} }));
vi.mock('../src/features/ModelCatalog/api', () => ({ modelCatalogApi: {} }));
vi.mock('../src/features/SystemRoleChat/SystemRoleChat', () => ({ SystemRoleChat: (props: unknown) => { h.service(props); return createElement('div', null, 'Сервисные задачи'); } }));
vi.mock('../src/features/ProjectChat/ProjectChatWorkspace', () => ({ ProjectChatWorkspace: (props: unknown) => { h.team(props); return createElement('div', null, 'Общая команда'); } }));
vi.mock('antd', async () => modalAntd(h.ui, (await import('react')).createElement));
import ChatOverlay from '../src/features/ModelChat/ChatOverlay';

const render = () => { h.hooks.begin(); h.ui.nodes = []; const html = renderToStaticMarkup(createElement(ChatOverlay, { projectId: 'prj-one', onClose: vi.fn() })); h.hooks.commit(); return html; };
const mode = (value: string) => uiNode(h.ui, 'RadioGroup').onChange({ target: { value } });
beforeEach(() => { h.hooks.dispose(); vi.clearAllMocks(); h.owner = 'alice'; h.role = 'Главный админ'; });
afterEach(() => { h.hooks.dispose(); });
const chooseRole = (id: string) => h.ui.nodes.find(node => node.kind === 'Select' && node.props['aria-label'] === 'Чат сервисной роли')!.props.onChange(id);
it('opens separate pinned role conversations in the common Chat without a mixed service modal', async () => {
    render(); expect(uiNode(h.ui, 'RadioGroup').options.map((item: {value: string}) => item.value)).toEqual(['team', 'personal']);
    expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text.includes('Прежние сервисные диалоги'))).toBe(false);
    chooseRole('agent-coordinator'); render(); await vi.dynamicImportSettled(); expect(render()).toContain('Чат · Координатор');
    expect(h.service).toHaveBeenLastCalledWith(expect.objectContaining({projectId: 'prj-one', agentId: 'agent-coordinator', canExecute: true}));
    chooseRole('agent-packager'); render(); await vi.dynamicImportSettled(); expect(render()).toContain('Чат · Упаковщик');
    expect(h.service).toHaveBeenLastCalledWith(expect.objectContaining({agentId: 'agent-packager'}));
    mode('team'); render(); await vi.dynamicImportSettled(); expect(render()).toContain('Общая команда');
});
it('a demoted observer can still open each role history with new execution disabled', async () => {
    h.role = 'Наблюдатель'; render(); chooseRole('agent-indexer'); render(); await vi.dynamicImportSettled(); render();
    expect(h.service).toHaveBeenLastCalledWith(expect.objectContaining({projectId: 'prj-one', agentId: 'agent-indexer', canExecute: false}));
});
