import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelCatalog} from '../src/features/ModelCatalog/ModelCatalog';
import {AgentCatalog} from '../src/features/AgentCatalog/AgentCatalog';
import type {IProviderSetupModalProps} from '../src/features/OpenCodeProviders/ProviderSetupModal';
import type {ModelCard} from '../src/features/ModelCatalog/ModelCard';
import type {OpenCodeImportModal} from '../src/features/ModelCatalog/OpenCodeImportModal';
import {adminSetupHooks} from './admin-setup-hooks.fixture';
import {bridgeFixture, model, selection} from './opencode-provider.fixture';
import {catalog as agentCatalog} from './agent-fixtures';

const ui = vi.hoisted(() => ({owner: 'admin-a', buttons: new Map<string, {onClick?: () => void}>(), cards: [] as Array<Parameters<typeof ModelCard>[0]>,
    modal: undefined as IProviderSetupModalProps | undefined, importModal: undefined as Parameters<typeof OpenCodeImportModal>[0] | undefined,
    apply: vi.fn(), refresh: vi.fn(), choose: vi.fn(), error: ''}));
let hooks = adminSetupHooks();
let bridge = bridgeFixture();
let catalogModels = [model, {...model, id: 'model-unassigned'}];
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: (initial: unknown) => hooks.state(initial),
    useRef: (initial: unknown) => hooks.ref(initial), useMemo: (factory: () => unknown, deps: unknown[]) => hooks.memo(factory, deps),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.effect(effect, deps)}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {activeRole: 'Главный админ', userRoles: ['Главный админ']}}})}));
vi.mock('react-router-dom', () => ({useHistory: () => ({push: vi.fn()})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const owner = ui.owner; return {scope: owner, captureOwner: () => () => owner === ui.owner};}}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({FeatureButton: ({children, onClick}: {children: ReactNode; onClick?: () => void}) => {ui.buttons.set(String(children), {onClick}); return children;}}));
vi.mock('../src/features/ModelCatalog/useModelCatalog', () => ({useModelCatalog: () => ({catalog: {items: catalogModels, assignedModelIds: [model.id]}, loading: false, error: ui.error, refresh: ui.refresh})}));
vi.mock('../src/features/ProjectEmbedding/EmbeddingTarget', () => ({useEmbeddingTarget: () => ({bridge, blocked: false}), EmbeddingTargetFields: () => null}));
vi.mock('../src/features/ProjectEmbedding/useProjectReindex', () => ({useProjectReindex: () => ({pending: false, busy: false})}));
vi.mock('../src/features/ProjectEmbedding/ProjectReindexStatus', () => ({ProjectReindexStatus: () => null}));
vi.mock('../src/features/ModelCatalog/ModelCard', () => ({ModelCard: (props: Parameters<typeof ModelCard>[0]) => {ui.cards.push(props); return null;}}));
vi.mock('../src/features/ModelCatalog/ModelDetails', () => ({ModelDetails: () => null}));
vi.mock('../src/features/ModelCatalog/ModelEditModal', () => ({ModelEditModal: () => null}));
vi.mock('../src/features/ModelCatalog/RemoteConnectionModal', () => ({RemoteConnectionModal: () => null}));
vi.mock('../src/features/ModelCatalog/OpenCodeImportModal', () => ({OpenCodeImportModal: (props: Parameters<typeof OpenCodeImportModal>[0]) => {ui.importModal = props; return null;}}));
vi.mock('../src/features/ModelChat/ModelChatModal', () => ({ModelChatModal: () => null}));
vi.mock('../src/features/OpenCodeProviders/ProviderSetupModal', () => ({ProviderSetupModal: (props: IProviderSetupModalProps) => {ui.modal = props; return createElement('div', null, 'provider modal');}}));
vi.mock('../src/features/McpBridge/BridgeConnection', () => ({BridgeConnection: () => null}));
vi.mock('../src/features/AgentCatalog/useAgentCatalog', () => ({useAgentCatalog: () => ({catalog: agentCatalog(), loading: false, error: '', refresh: ui.refresh})}));
vi.mock('../src/features/AgentCatalog/useAgentReadiness', () => ({useAgentReadiness: () => ({items: [], refresh: vi.fn()})}));
vi.mock('../src/features/AgentCatalog/useAgentActions', () => ({useAgentActions: () => ({busy: false, error: '', notice: '', unconfirmed: false, apply: ui.apply})}));
vi.mock('../src/features/AgentCatalog/AgentCard', () => ({AgentCard: () => null}));
vi.mock('../src/features/AgentCatalog/AgentDetails', () => ({AgentDetails: () => null}));
vi.mock('../src/features/AgentCatalog/AgentEditModal', () => ({AgentEditModal: () => null}));
vi.mock('../src/features/AgentCatalog/ProjectAgentEditor', () => ({ProjectAgentEditor: () => null}));
vi.mock('../src/features/AgentCatalog/AgentTrialModal', () => ({AgentTrialModal: () => null}));
// This suite covers provider handoff and explicit apply; method execution has its own component/hook tests.
vi.mock('../src/features/AgentMethods/AgentMethodWorkflow', () => ({AgentMethodWorkflow: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children, input = () => null;
    return {Space: content, Tooltip: content, Row: content, Col: content, Empty: content, Checkbox: content, Spin: input, Modal: {confirm: vi.fn()},
        Alert: content, Input: {Search: input}, Typography: {Title: content, Text: content, Paragraph: content},
        Button: ({children, onClick}: {children: ReactNode; onClick?: () => void}) => {ui.buttons.set(String(children), {onClick}); return children;}};
});
let projectId: string | undefined, canManage = true;
function render(agents = false, commit = true) {hooks.begin(); ui.buttons.clear(); ui.cards = []; ui.modal = undefined; ui.importModal = undefined;
    const html = renderToStaticMarkup(agents ? createElement(AgentCatalog, {projectId, canManage, isMain: true, bridge: bridgeFixture()})
        : createElement(ModelCatalog, {projectId, canManage, isMain: true})); if (commit) hooks.commit(); return html;}
beforeEach(() => {hooks = adminSetupHooks(); projectId = selection.projectId; canManage = true; ui.owner = 'admin-a'; ui.error = ''; catalogModels = [model, {...model, id: 'model-unassigned'}]; vi.clearAllMocks(); bridge = bridgeFixture(); bridge.choose = ui.choose;});
afterEach(() => hooks.dispose());

describe('Catalog and agent handoff into local provider setup', () => {
    it('Project primary entry reuses the selected bridge and only assigned models', () => {
        render(); ui.buttons.get('Настроить в OpenCode')!.onClick!(); render();
        expect(ui.modal).toMatchObject({projectId, canManage: true, catalogReady: true}); expect(ui.modal!.models.map(item => item.id)).toEqual([model.id]);
        expect(ui.modal!.bridge.device!.id).toBe(selection.deviceId); expect(ui.apply).not.toHaveBeenCalled();
    });
    it('Card entry preselects its model; closing does not mutate the server connection', () => {
        render(); ui.cards[0].onSetupProvider!(); render(); expect(ui.modal!.initialModelId).toBe(model.id); ui.modal!.onClose(); render(); expect(ui.modal).toBeUndefined(); expect(ui.refresh).not.toHaveBeenCalled();
    });
    it('The Ollama card selects Ollama and its exact catalog model without starting server mutations', () => {
        catalogModels[0] = {...model, runtime: 'remote-ollama', model: 'qwen3:8b'};
        render(); ui.cards[0].onSetupProvider!(); render();
        expect(ui.modal).toMatchObject({initialModelId: model.id, initialProviderKind: 'ollama'});
        expect(ui.modal!.models).toEqual([catalogModels[0]]); expect(ui.apply).not.toHaveBeenCalled(); expect(ui.refresh).not.toHaveBeenCalled();
    });
    it.each(['project', 'permission'])('A retained Ollama card callback cannot reopen setup after %s changes before effects commit', mode => {
        catalogModels[0] = {...model, runtime: 'remote-ollama'}; render(); const open = ui.cards[0].onSetupProvider!;
        if (mode === 'project') projectId = 'prj-next'; else canManage = false;
        render(false, false); open(); hooks.commit(); render(); expect(ui.modal).toBeUndefined(); expect(ui.choose).not.toHaveBeenCalled();
    });
    it('Codex import hands off the exact scan computer without choosing a catalog model or starting any operation', () => {
        const computer = {...bridge.device!, id: '55555555-5555-4555-8555-555555555555', name: 'Компьютер сканирования'};
        bridge.devices.push(computer); render(); ui.buttons.get('Из OpenCode')!.onClick!(); render();
        ui.importModal!.onConfigureCodex!(computer.id); render();
        expect(ui.choose).toHaveBeenCalledExactlyOnceWith(computer.id); expect(ui.importModal).toBeUndefined();
        expect(ui.modal).toMatchObject({initialProviderKind: 'codex-bridge', bridge: {device: computer}}); expect(ui.modal!.initialModelId).toBeUndefined();
        expect(ui.apply).not.toHaveBeenCalled(); expect(ui.refresh).not.toHaveBeenCalled();
        bridge.devices = [bridge.device!]; render(); expect(ui.modal!.bridge.device).toBeUndefined();
        ui.modal!.bridge.choose(selection.deviceId); render(); expect(ui.modal!.bridge.device!.id).toBe(selection.deviceId);
    });
    it('Global/read-only import has no local handoff; an old actor callback cannot choose a computer', () => {
        render(); ui.buttons.get('Из OpenCode')!.onClick!(); render(); const configure = ui.importModal!.onConfigureCodex!;
        ui.owner = 'admin-b'; configure(selection.deviceId); render(); expect(ui.modal).toBeUndefined(); expect(ui.choose).not.toHaveBeenCalled();
        projectId = undefined; render(); ui.buttons.get('Из OpenCode')!.onClick!(); render(); expect(ui.importModal!.onConfigureCodex).toBeUndefined();
        projectId = selection.projectId; canManage = false; render(); ui.buttons.get('Из OpenCode')!.onClick!(); render(); expect(ui.importModal!.onConfigureCodex).toBeUndefined();
    });
    it.each(['project', 'permission'])('A retained Codex handoff cannot change the shared computer after %s changes, before effects commit', mode => {
        render(); ui.buttons.get('Из OpenCode')!.onClick!(); render(); const configure = ui.importModal!.onConfigureCodex!;
        if (mode === 'project') projectId = 'prj-next'; else canManage = false;
        render(false, false); configure(selection.deviceId); expect(ui.choose).not.toHaveBeenCalled();
        hooks.commit(); render(); expect(ui.modal).toBeUndefined();
    });
    it.each(['project', 'permission'])('No setup is created without %s', mode => {
        if (mode === 'project') projectId = undefined; else canManage = false; render(); expect(ui.buttons.has('Настроить в OpenCode')).toBe(false); expect(ui.modal).toBeUndefined();
    });
    it('Actor change before rerender rejects the old entry callback', () => {
        render(); const callback = ui.buttons.get('Настроить в OpenCode')!.onClick!; ui.owner = 'admin-b'; callback(); render(); expect(ui.modal).toBeUndefined();
    });
    it('Project change immediately hides the old modal instead of silently opening it in another project', () => {
        render(); ui.buttons.get('Настроить в OpenCode')!.onClick!(); render(); expect(ui.modal).toBeDefined(); projectId = 'prj-next'; render(); expect(ui.modal).toBeUndefined();
    });
    it('Catalog failure keeps the entry visible with explicit unconfirmed catalog state', () => {
        ui.error = 'read failed'; render(); ui.buttons.get('Настроить в OpenCode')!.onClick!(); render(); expect(ui.modal).toMatchObject({catalogReady: false, catalogError: 'read failed'});
    });
    it.each([false, true])('A stale close callback cannot close a newly opened provider dialog (agents=%s)', agents => {
        const label = agents ? 'Настроить провайдера' : 'Настроить в OpenCode'; render(agents); ui.buttons.get(label)!.onClick!(); render(agents);
        const oldClose = ui.modal!.onClose; oldClose(); render(agents); ui.buttons.get(label)!.onClick!(); render(agents); expect(ui.modal).toBeDefined();
        oldClose(); render(agents); expect(ui.modal).toBeDefined();
    });
    it('Agent setup returns to a separate explicit apply action with no automatic application', () => {
        render(true); ui.buttons.get('Настроить провайдера')!.onClick!(); render(true); expect(ui.modal).toBeDefined(); expect(ui.apply).not.toHaveBeenCalled();
        ui.modal!.onConfigured!(); render(true); expect(ui.modal).toBeUndefined(); expect(ui.apply).not.toHaveBeenCalled(); ui.buttons.get('Применить настройки')!.onClick!(); expect(ui.apply).toHaveBeenCalledOnce();
    });
});
