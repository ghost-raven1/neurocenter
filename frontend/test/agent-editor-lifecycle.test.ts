import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import {modalAntd, uiNode} from './modal-actions.fixture';
import {agent, assignment, catalog} from './agent-fixtures';
import type {IAgentEditorValues} from '../src/features/AgentCatalog/AgentDefinitionFields';
import type {ICatalogAgent, IProjectAgent} from '../src/features/AgentCatalog/types';
import type {IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
type Confirmation = {onOk: () => void; destroy: ReturnType<typeof vi.fn>};
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture'), {modalUi} = await import('./modal-actions.fixture');
    return {hooks: adminSetupHooks(), ui: modalUi(), owner: 'alice', active: true, enabled: true, dirty: false,
        close: vi.fn(), saved: vi.fn(), save: vi.fn(), confirmations: [] as Confirmation[]};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    const owner = h.owner; return {captureOwner: () => () => h.active && owner === h.owner};
}}));
vi.mock('../src/features/AgentCatalog/useUnsavedAgentPrompt', () => ({useUnsavedAgentPrompt: (dirty: boolean) => { h.dirty = dirty; }}));
vi.mock('../src/features/AgentCatalog/api', () => ({agentCatalogApi: {create: vi.fn(), update: vi.fn(), get: vi.fn(), list: vi.fn()}}));
vi.mock('../src/features/AgentCatalog/AgentDefinitionFields', async original => ({...await original<typeof import('../src/features/AgentCatalog/AgentDefinitionFields')>(), AgentDefinitionFields: () => null}));
vi.mock('antd', async () => {
    const ui = modalAntd(h.ui, (await import('react')).createElement), content = ({children}: {children?: ReactNode}) => children;
    return {...ui, Tooltip: content, Collapse: Object.assign(content, {Panel: content}), Modal: Object.assign(ui.Modal, {
        confirm: (options: Omit<Confirmation, 'destroy'>) => { const confirmation = {...options, destroy: vi.fn()}; h.confirmations.push(confirmation); return confirmation; },
    })};
});
import {AgentEditModal} from '../src/features/AgentCatalog/AgentEditModal';
import {ProjectAgentEditor} from '../src/features/AgentCatalog/ProjectAgentEditor';
import {agentCatalogApi} from '../src/features/AgentCatalog/api';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';
const data = (): IEvaluatedFeatureFlags => ({flags: Object.fromEntries(featureFlagKeys.map(key => [key, h.enabled])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, h.enabled])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))}) as IEvaluatedFeatureFlags;
const values = (): IAgentEditorValues => ({...agent(), name: '  Ревьюер  ', definition: {...agent().definition, description: '  Проверяет изменения  ', prompt: '  # МОЙ ТЕКСТ\n\nОтступы важны.  '}});
let current: ICatalogAgent | undefined, projectAssignment: IProjectAgent;
const render = (project = false) => {
    h.hooks.begin(); h.ui.nodes = []; h.ui.fields.clear();
    const content = project ? createElement(ProjectAgentEditor, {projectId: 'project-one', assignment: projectAssignment, revision: 3, onClose: h.close, onSave: h.save})
        : createElement(AgentEditModal, {agent: current, onClose: h.close, onSaved: h.saved});
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data: data(), loading: false, error: null, refresh: async () => undefined}}, content));
    h.hooks.commit(); return html;
};
const finish = async () => { h.ui.finish(h.ui.values); await flushSetup(); };
const button = (label: string) => uiNode(h.ui, 'Button', label);
beforeEach(() => {
    h.hooks.dispose(); vi.resetAllMocks(); h.owner = 'alice'; h.active = true; h.enabled = true; h.dirty = false; h.confirmations = []; current = undefined; projectAssignment = assignment();
    h.ui.values = values(); h.ui.form.submit = () => h.ui.finish(h.ui.values); h.close.mockReset(); h.saved.mockResolvedValue(undefined); h.save.mockResolvedValue({revision: 4});
    vi.mocked(agentCatalogApi.create).mockResolvedValue(agent()); vi.mocked(agentCatalogApi.update).mockResolvedValue(agent({version: 2})); vi.mocked(agentCatalogApi.get).mockResolvedValue(agent({version: 2})); vi.mocked(agentCatalogApi.list).mockResolvedValue(catalog());
    let sequence = 0; vi.stubGlobal('crypto', {randomUUID: vi.fn(() => `11111111-1111-4111-8111-${String(++sequence).padStart(12, '0')}`)});
});
afterEach(() => { h.hooks.dispose(); vi.unstubAllGlobals(); });

describe('Catalog template editor: actual form events and async ownership', () => {
    it('clean close is immediate; dirty close requires confirmation whose cleanup runs on unmount', () => {
        render(); uiNode(h.ui, 'Modal').onCancel(); expect(h.close).toHaveBeenCalledOnce(); h.close.mockClear(); h.ui.change(); render(); expect(h.dirty).toBe(true);
        button('Отмена').onClick(); expect(h.close).not.toHaveBeenCalled(); h.confirmations[0].onOk(); expect(h.close).toHaveBeenCalledOnce(); h.hooks.dispose(); expect(h.confirmations[0].destroy).toHaveBeenCalledOnce();
    });
    it('busy close and double submit cannot escape the held write; confirmed refresh precedes closing', async () => {
        const pending = deferredSetup<ICatalogAgent>(), refreshed = deferredSetup<void>(); vi.mocked(agentCatalogApi.create).mockReturnValueOnce(pending.promise); h.saved.mockReturnValueOnce(refreshed.promise);
        render(); h.ui.finish(h.ui.values); h.ui.finish(h.ui.values); render(); expect(uiNode(h.ui, 'Modal')).toMatchObject({closable: false, keyboard: false}); uiNode(h.ui, 'Modal').onCancel(); expect(h.close).not.toHaveBeenCalled(); expect(h.confirmations).toEqual([]);
        pending.resolve(agent()); await flushSetup(); expect(h.saved).toHaveBeenCalledExactlyOnceWith(agent()); expect(h.close).not.toHaveBeenCalled(); refreshed.resolve(); await flushSetup(); expect(h.close).toHaveBeenCalledOnce(); expect(agentCatalogApi.create).toHaveBeenCalledOnce();
    });
    it('name/description normalize while Markdown bytes stay intact; retry reuses a request until the draft changes', async () => {
        vi.mocked(agentCatalogApi.create).mockRejectedValue(Error('Ответ потерян')); render(); await finish(); const first = vi.mocked(agentCatalogApi.create).mock.calls[0];
        expect(first[0]).toMatchObject({name: 'Ревьюер', description: 'Проверяет изменения', definition: {prompt: values().definition.prompt}}); await finish(); expect(vi.mocked(agentCatalogApi.create).mock.calls[1][1]).toBe(first[1]);
        h.ui.values.definition.prompt += '\nЕщё одно правило.'; await finish(); expect(vi.mocked(agentCatalogApi.create).mock.calls[2][1]).not.toBe(first[1]); expect(render()).toContain('Ответ потерян'); expect(h.close).not.toHaveBeenCalled();
    });
    it('a failed catalog refresh keeps the saved template receipt idempotent and the editor retryable', async () => {
        h.saved.mockRejectedValueOnce(Error('Каталог не перечитан')); render(); await finish(); const key = vi.mocked(agentCatalogApi.create).mock.calls[0][1]; expect(render()).toContain('Каталог не перечитан'); expect(h.close).not.toHaveBeenCalled();
        await finish(); expect(vi.mocked(agentCatalogApi.create).mock.calls[1][1]).toBe(key); expect(h.close).toHaveBeenCalledOnce();
    });
    it.each(['before-write', 'write-success', 'write-error', 'saved-refresh'] as const)('owner change at %s cannot close or replace another account editor', async stage => {
        const pending = deferredSetup<ICatalogAgent>(), refreshed = deferredSetup<void>(); vi.mocked(agentCatalogApi.create).mockReturnValueOnce(pending.promise); h.saved.mockReturnValueOnce(refreshed.promise); render();
        if (stage === 'before-write') { h.active = false; await finish(); expect(agentCatalogApi.create).not.toHaveBeenCalled(); return; }
        h.ui.finish(h.ui.values); if (stage === 'saved-refresh') { pending.resolve(agent()); await flushSetup(); expect(h.saved).toHaveBeenCalledOnce(); }
        h.owner = 'bob'; if (stage === 'write-error') pending.reject(Error('PRIVATE OLD ERROR')); else pending.resolve(agent()); refreshed.resolve(); await flushSetup();
        expect(h.close).not.toHaveBeenCalled(); expect(render()).not.toContain('PRIVATE OLD ERROR'); if (stage !== 'saved-refresh') expect(h.saved).not.toHaveBeenCalled();
    });
    it('missing secure UUID leaves a blank initial slug and refuses network work with an actionable message', async () => {
        vi.stubGlobal('crypto', {randomUUID: () => { throw Error('Unavailable'); }}); render(); expect(uiNode(h.ui, 'Form').initialValues.slug).toBe(''); await finish();
        expect(agentCatalogApi.create).not.toHaveBeenCalled(); expect(render()).toContain('HTTPS или через localhost');
    });
    it('name validation rejects multiline and malformed UTF-8, accepts an empty optional validation pass', async () => {
        render(); const rule = h.ui.fields.get('name').rules.find((item: {validator?: unknown}) => item.validator).validator;
        await expect(rule(undefined, undefined)).resolves.toBeUndefined(); await expect(rule(undefined, 'Ревьюер')).resolves.toBeUndefined();
        await expect(rule(undefined, 'Две\nстроки')).rejects.toThrow('одной строкой'); await expect(rule(undefined, '\ud800')).rejects.toThrow('UTF-8');
    });
    it('conflict comparison never overwrites draft; explicit rebase uses the new pin and a new request key', async () => {
        current = agent(); const newer = agent({version: 2, manifest: 'b'.repeat(64), definition: {...agent().definition, prompt: 'ЧУЖОЙ ПРОМПТ'}}); vi.mocked(agentCatalogApi.update).mockRejectedValueOnce({response: {status: 409}}).mockResolvedValueOnce(newer); vi.mocked(agentCatalogApi.get).mockResolvedValueOnce(newer);
        render(); await finish(); const oldKey = vi.mocked(agentCatalogApi.update).mock.calls[0][2]; expect(render()).toContain('ЧУЖОЙ ПРОМПТ'); expect(h.ui.values.definition.prompt).toBe(values().definition.prompt); expect(agentCatalogApi.update).toHaveBeenCalledOnce();
        button('Сохранить мой вариант поверх версии 2').onClick({}); await flushSetup(); expect(vi.mocked(agentCatalogApi.update).mock.calls[1][0]).toEqual(newer); expect(vi.mocked(agentCatalogApi.update).mock.calls[1][2]).not.toBe(oldKey); expect(h.close).toHaveBeenCalledOnce();
    });
    it.each(['get-failed', 'same-version', 'owner-changed', 'archived'] as const)('conflict recovery %s keeps the original editable text and prevents implicit overwrite', async stage => {
        current = agent(); vi.mocked(agentCatalogApi.update).mockRejectedValueOnce({response: {status: 409}}); const pending = deferredSetup<ICatalogAgent>();
        if (stage === 'get-failed') vi.mocked(agentCatalogApi.get).mockRejectedValueOnce(Error('Comparison unavailable'));
        else if (stage === 'same-version') vi.mocked(agentCatalogApi.get).mockResolvedValueOnce(agent());
        else if (stage === 'archived') vi.mocked(agentCatalogApi.get).mockResolvedValueOnce(agent({version: 2, archivedAt: '2026-10-22'}));
        else vi.mocked(agentCatalogApi.get).mockReturnValueOnce(pending.promise);
        render(); await finish(); if (stage === 'owner-changed') { h.owner = 'bob'; pending.resolve(agent({version: 2, name: 'PRIVATE COMPARISON'})); await flushSetup(); }
        const html = render(); expect(h.ui.values.definition.prompt).toBe(values().definition.prompt); expect(h.close).not.toHaveBeenCalled();
        if (stage === 'archived') { expect(button('Сохранить мой вариант поверх версии 2').disabled).toBe(true); button('Сохранить мой вариант поверх версии 2').onClick({}); expect(agentCatalogApi.update).toHaveBeenCalledOnce(); }
        else { expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text.includes('поверх версии'))).toBe(false); expect(html).not.toContain('PRIVATE COMPARISON'); }
    });
    it('agents off blocks Enter/form submit independently of the visible button', async () => {
        h.enabled = false; render(); expect(button('Сохранить агента').disabled).toBe(true); await finish(); expect(agentCatalogApi.create).not.toHaveBeenCalled();
    });
});

describe('Project agent editor: draft preservation, pinned reset and explicit CAS rebase', () => {
    it('dirty close confirms, clean close does not, and cleanup destroys an outstanding confirmation', () => {
        render(true); uiNode(h.ui, 'Modal').onCancel(); expect(h.close).toHaveBeenCalledOnce(); h.close.mockClear(); h.ui.change(); render(true); expect(h.dirty).toBe(true); button('Отмена').onClick(); expect(h.close).not.toHaveBeenCalled(); h.confirmations[0].onOk(); expect(h.close).toHaveBeenCalledOnce(); h.hooks.dispose(); expect(h.confirmations[0].destroy).toHaveBeenCalledOnce();
    });
    it('double submit and close stay locked until the exact pin/revision write finishes', async () => {
        const pending = deferredSetup<unknown>(); h.save.mockReturnValueOnce(pending.promise); render(true); h.ui.finish(h.ui.values); h.ui.finish(h.ui.values); render(true); uiNode(h.ui, 'Modal').onCancel(); expect(h.close).not.toHaveBeenCalled(); expect(h.save).toHaveBeenCalledExactlyOnceWith(agent(), {overrides: {prompt: values().definition.prompt}}, 3);
        pending.resolve({revision: 4}); await flushSetup(); expect(h.close).toHaveBeenCalledOnce();
    });
    it('an unconfirmed save result keeps the editor; reset clears optional values and leaves an explicit dirty draft', async () => {
        h.save.mockResolvedValueOnce(undefined); render(true); await finish(); expect(h.close).not.toHaveBeenCalled(); render(true); button('Вернуть закреплённый шаблон').onClick(); render(true); expect(h.dirty).toBe(true);
        expect(h.ui.values.definition).toMatchObject({...agent().definition, model: undefined, temperature: undefined, topP: undefined, steps: undefined, permission: {bash: undefined, read: 'allow', edit: 'ask'}}); expect(h.save).toHaveBeenCalledOnce();
    });
    it.each(['before-write', 'success', 'failure'] as const)('owner loss at %s cannot mutate or close another editor', async stage => {
        const pending = deferredSetup<unknown>(); h.save.mockReturnValueOnce(pending.promise); render(true); if (stage === 'before-write') { h.active = false; await finish(); expect(h.save).not.toHaveBeenCalled(); return; }
        h.ui.finish(h.ui.values); h.owner = 'bob'; if (stage === 'success') pending.resolve({revision: 4}); else pending.reject(Error('PRIVATE FAILED SAVE')); await flushSetup(); expect(h.close).not.toHaveBeenCalled(); expect(render(true)).not.toContain('PRIVATE FAILED SAVE');
    });
    it('new current project prompt is comparison-only until explicit rebase against its revision and immutable card', async () => {
        const pinned = agent({version: 2, manifest: 'b'.repeat(64), definition: {...agent().definition, prompt: 'НОВЫЙ ШАБЛОН'}}), newer = assignment({version: 2, manifest: pinned.manifest, card: pinned, effective: {...pinned.definition, prompt: 'ТЕКСТ ДРУГОГО АДМИНА'}});
        h.save.mockRejectedValueOnce({response: {status: 409}}); vi.mocked(agentCatalogApi.list).mockResolvedValueOnce(catalog({revision: 7, assignments: [newer]})); render(true); await finish(); expect(render(true)).toContain('ТЕКСТ ДРУГОГО АДМИНА'); expect(h.save).toHaveBeenCalledOnce();
        button('Применить мой вариант к актуальным настройкам').onClick({}); await flushSetup(); expect(h.save).toHaveBeenLastCalledWith(pinned, {overrides: {prompt: values().definition.prompt}}, 7); expect(h.close).toHaveBeenCalledOnce();
    });
    it.each(['list-failed', 'malformed', 'null-revision', 'removed', 'owner-changed'] as const)('failed comparison %s does not replace its original draft or invent a safe revision', async stage => {
        h.save.mockRejectedValueOnce({response: {status: 409}}); const pending = deferredSetup<ReturnType<typeof catalog>>();
        if (stage === 'list-failed') vi.mocked(agentCatalogApi.list).mockRejectedValueOnce(Error('Read failed'));
        else if (stage === 'malformed') vi.mocked(agentCatalogApi.list).mockResolvedValueOnce({revision: 7} as ReturnType<typeof catalog>);
        else if (stage === 'null-revision') vi.mocked(agentCatalogApi.list).mockResolvedValueOnce(catalog({revision: null}));
        else if (stage === 'removed') vi.mocked(agentCatalogApi.list).mockResolvedValueOnce(catalog({revision: 7, assignments: [assignment({removed: true})]}));
        else vi.mocked(agentCatalogApi.list).mockReturnValueOnce(pending.promise);
        render(true); await finish(); if (stage === 'owner-changed') { h.owner = 'bob'; pending.resolve(catalog({revision: 7, assignments: [assignment({effective: {...agent().definition, prompt: 'PRIVATE PROJECT PROMPT'}})]})); await flushSetup(); }
        const html = render(true); expect(h.ui.values.definition.prompt).toBe(values().definition.prompt); expect(h.close).not.toHaveBeenCalled(); expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text.includes('Применить мой вариант'))).toBe(false); expect(html).not.toContain('PRIVATE PROJECT PROMPT'); if (stage === 'removed') expect(html).toContain('Агент уже удалён из проекта');
    });
    it('agents off prevents a project form submit and still permits closing the editor', async () => {
        h.enabled = false; render(true); await finish(); expect(h.save).not.toHaveBeenCalled(); expect(button('Сохранить и применить').disabled).toBe(true); button('Отмена').onClick(); expect(h.close).toHaveBeenCalledOnce();
    });
});
