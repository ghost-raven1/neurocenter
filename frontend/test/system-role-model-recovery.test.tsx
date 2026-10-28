// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ServiceComposer} from '../src/features/SystemRoleChat/ServiceComposer';
import type {SystemRoleId} from '../src/features/SystemRoles/types';
import {serviceIntentScope} from '../src/features/SystemRoleChat/intent';

const h = vi.hoisted(() => ({owner: '', capture: () => {const owner = h.owner; return () => owner === h.owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: h.owner, captureOwner: h.capture})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: true, reason: ''})}));
vi.mock('../src/features/SystemRoleChat/McpTaskPicker', () => ({McpTaskPicker: () => null}));
vi.mock('antd', async () => {
    const {createElement: element} = await import('react');
    const box = (tag: string) => ({children}: any) => element(tag, null, children);
    const Checkbox = ({children, checked, onChange, disabled}: any) => element('label', null, element('input', {type: 'checkbox', checked, onChange, disabled}), children);
    return {
        Alert: ({message, description}: any) => element('div', {role: 'alert'}, message, description),
        Button: ({children, disabled, onClick}: any) => element('button', {disabled, onClick}, children),
        Form: Object.assign(({children, disabled}: any) => element('fieldset', {disabled}, children), {Item: box('label')}),
        Input: {TextArea: ({value, onChange, 'aria-label': label}: any) => element('textarea', {value, onChange, 'aria-label': label})},
        Select: ({value, options = [], onChange, 'aria-label': label}: any) => element('select', {value: value ?? '', 'aria-label': label, onChange: (event: any) => onChange(event.target.value || undefined)},
            element('option', {value: ''}, 'Выберите модель'), ...options.map((item: any) => element('option', {key: item.value, value: item.value, disabled: item.disabled}, item.label))),
        Checkbox: Object.assign(Checkbox, {Group: () => null}), Typography: {Paragraph: box('p'), Text: box('span')},
    };
});

const models = [{id: 'model-tools', name: 'Tools', pin: 'a'.repeat(64)}, {id: 'model-delay', name: 'Delay', pin: 'b'.repeat(64)}];
let root: Root, container: HTMLDivElement, composer = ServiceComposer, value: any, sequence = 0;
const principal = (id: string, activeRole = 'Админ проекта') => JSON.stringify({id, email: id + '@test', activeRole});
const selectedModel = () => container.querySelector<HTMLSelectElement>('[aria-label="Модель чата роли"]')!;
const render = async (agentId: SystemRoleId = 'agent-coordinator', projectId = 'project-one') => {
    await act(async () => {root.render(createElement(composer, {key: JSON.stringify([h.owner, projectId, agentId]), value, projectId, fixedAgentId: agentId}));});
};
const choose = async (modelId: string) => {await act(async () => {selectedModel().value = modelId; selectedModel().dispatchEvent(new Event('change', {bubbles: true}));});};
const instruction = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
const typeInstruction = async (text: string) => {await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(instruction(), text);
    instruction().dispatchEvent(new Event('input', {bubbles: true}));
});};
const prepareButton = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Проверить контекст')!;
const reload = async () => {
    await act(async () => root.unmount());
    vi.resetModules(); composer = (await import('../src/features/SystemRoleChat/ServiceComposer')).ServiceComposer;
    root = createRoot(container);
};
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); sessionStorage.clear();
    h.owner = principal('role-model-owner-' + ++sequence); composer = ServiceComposer;
    value = {overview: {definitions: [{id: 'agent-coordinator', diagnostics: [], targets: []}, {id: 'agent-ai-admin', diagnostics: [], targets: []}], models: [...models], targets: [], budget: {diagnostics: 5}},
        busy: false, prepare: vi.fn(), start: vi.fn(), invalidate: vi.fn()};
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('keeps the chosen Coordinator model when navigating to AI admin and back without inference', async () => {
    await render(); await choose('model-delay'); await typeInstruction('Coordinator draft'); expect(selectedModel().value).toBe('model-delay');
    await render('agent-ai-admin'); expect(selectedModel().value).toBe('model-tools'); await typeInstruction('AI draft');
    await render('agent-coordinator'); expect(selectedModel().value).toBe('model-delay'); expect(instruction().value).toBe('Coordinator draft');
    await render('agent-ai-admin'); expect(instruction().value).toBe('AI draft');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('separates the preference by person, project and service role while retaining it across a rights change', async () => {
    const alice = h.owner;
    await render(); await choose('model-delay');
    await render('agent-ai-admin'); expect(selectedModel().value).toBe('model-tools');
    await render('agent-coordinator', 'project-two'); expect(selectedModel().value).toBe('model-tools');
    h.owner = principal('other-person-' + sequence); await render(); expect(selectedModel().value).toBe('model-tools');
    h.owner = alice; await render(); expect(selectedModel().value).toBe('model-delay');
    h.owner = JSON.stringify({...JSON.parse(alice), activeRole: 'Наблюдатель'}); await render(); expect(selectedModel().value).toBe('model-delay');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('preserves an explicit model clear across role navigation and a full module reload', async () => {
    await render(); await choose('model-delay'); await choose('');
    await render('agent-ai-admin'); await render(); expect(selectedModel().value).toBe('');
    await reload(); await render(); expect(selectedModel().value).toBe('');
    expect(value.start).not.toHaveBeenCalled();
});

it('keeps a stale chosen model visibly unavailable and requires a current allowed choice', async () => {
    await render(); await choose('model-delay'); await typeInstruction('Preserved task');
    value.overview.models = [models[0]]; await render();
    expect(selectedModel().selectedOptions[0].disabled).toBe(true);
    expect(container.textContent).toContain('Ранее выбранная модель сейчас недоступна');
    expect(instruction().value).toBe('Preserved task'); expect(prepareButton().disabled).toBe(true);
    await reload(); await render(); expect(selectedModel().selectedOptions[0].disabled).toBe(true);
    await choose('model-tools'); expect(selectedModel().value).toBe('model-tools'); expect(prepareButton().disabled).toBe(false);
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('keeps the original unavailable pending-intent model ahead of the stored preference without rewriting it', async () => {
    await render(); await choose('model-delay'); await reload();
    value.receipt = {dialogId: 'pending-dialog', requestId: 'pending-request'};
    value.pendingIntent = {agentId: 'agent-coordinator', dialogId: 'pending-dialog', input: {requestId: 'pending-request', modelId: 'model-unavailable', instruction: 'Exact pending task'}};
    value.overview.models = [models[0]]; await render();
    expect(selectedModel().value).toBe('model-unavailable'); expect(selectedModel().selectedOptions[0].disabled).toBe(true);
    expect(instruction().value).toBe('Exact pending task'); expect(container.textContent).toContain('Модель сохранённого запроса сейчас недоступна');
    expect(container.querySelector('fieldset')!.disabled).toBe(true);
    value.receipt = undefined; value.pendingIntent = undefined; value.overview.models = [...models]; await reload(); await render();
    expect(selectedModel().value).toBe('model-delay');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('waits for current allowed choices before presenting a recovered preference', async () => {
    await render(); await choose('model-delay'); await reload();
    const overview = value.overview; value.overview = undefined; await render(); expect(selectedModel().value).toBe('');
    value.overview = overview; await render(); expect(selectedModel().value).toBe('model-delay');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it.each(['{broken', JSON.stringify({version: 2, modelId: 'model-delay'}), JSON.stringify({version: 1, modelId: {id: 'model-delay'}}), 'x'.repeat(1025)])('ignores malformed or oversized browser preferences safely: %s', async raw => {
    sessionStorage.setItem('neurocenter:role-chat-model:' + serviceIntentScope(h.owner, 'project-one', 'agent-coordinator'), raw);
    await render(); expect(selectedModel().value).toBe('model-tools');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('keeps explicit choices and draft editing available when browser storage reads and writes are blocked', async () => {
    vi.stubGlobal('sessionStorage', {getItem: () => {throw Error('Blocked');}, setItem: () => {throw Error('Blocked');}, removeItem: () => {throw Error('Blocked');}});
    await render(); await choose('model-delay'); await typeInstruction('In-memory draft');
    await render('agent-ai-admin'); await render();
    expect(selectedModel().value).toBe('model-delay'); expect(instruction().value).toBe('In-memory draft');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});

it('restores the chosen model from browser storage after a fresh module and mount', async () => {
    await render(); await choose('model-delay');
    await reload(); await render();
    expect(selectedModel().value).toBe('model-delay');
    expect(value.prepare).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
});
