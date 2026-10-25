// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {modalAntd} from './modal-actions.fixture';
import type {ChatSearchJob} from '../src/features/ChatSemanticSearch/types';
const h = await vi.hoisted(async () => {
    const {modalUi} = await import('./modal-actions.fixture');
    return {ui: modalUi(), enabled: true, captureOwner: () => () => true,
        listModels: vi.fn(), rooms: vi.fn(), history: vi.fn(), read: vi.fn(), create: vi.fn(), cancel: vi.fn()};
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: h.captureOwner})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: () => ({enabled: h.enabled, reason: 'Функция выключена'})}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {list: h.listModels}}));
vi.mock('../src/features/ProjectChat/api', () => ({projectChatApi: {rooms: h.rooms}}));
vi.mock('../src/features/ChatSemanticSearch/api', () => ({chatSemanticApi: {history: h.history, read: h.read, create: h.create, cancel: h.cancel}}));
vi.mock('antd', async () => modalAntd(h.ui, (await import('react')).createElement));
import {ChatSemanticSearchPanel} from '../src/features/ChatSemanticSearch/ChatSemanticSearchPanel';
const model = (pin = 'b'.repeat(64)) => ({id: 'model-embed', name: 'Embeddings', capability: 'embedding', runtime: 'remote-openai', dimension: 768,
    modelVersion: 'v1', verificationSha256: 'a'.repeat(64), modelPin: pin});
const job = (id: string): ChatSearchJob => ({id, projectId: 'prj-fixture', kind: 'search', state: 'SUCCEEDED', modelId: 'model-embed', modelPin: 'b'.repeat(64), indexedChunks: 0, results: []});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
let root: Root, container: HTMLDivElement;
const node = (kind: string, text?: string, label?: string) => {
    const value = h.ui.nodes.findLast(item => item.kind === kind && (text === undefined || item.text.includes(text)) && (label === undefined || item.props['aria-label'] === label));
    if (!value) throw Error('Missing ' + kind + ' ' + text + ' ' + label); return value.props;
};
const history = () => node('Select', undefined, 'История Индексатора');
const render = async () => {await act(async () => {root.render(createElement(ChatSemanticSearchPanel, {projectId: 'prj-fixture', onClose: () => undefined}));});};
const prepare = async () => {await act(async () => {
    node('Select', undefined, 'Embedding-модель для публичных чатов').onChange('model-embed');
    node('TextArea').onChange({target: {value: 'Смысловой запрос'}}); node('Checkbox').onChange({target: {checked: true}});
});};
const click = async (text: string) => {await act(async () => {node('Button', text).onClick();});};
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.ui.nodes = []; h.enabled = true;
    h.listModels.mockResolvedValue({items: [model()], assignedModelIds: ['model-embed']}); h.rooms.mockResolvedValue({rooms: []});
    h.history.mockResolvedValue([job('old-job')]); h.read.mockImplementation(async (_project: string, id: string) => job(id));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.unstubAllGlobals();});

it('history cannot replace an in-flight submission; its deferred ACK releases the form and keeps the accepted receipt', async () => {
    const ack = deferred<ChatSearchJob>(); h.create.mockReturnValue(ack.promise);
    await render(); await prepare(); const retainedChoice = history().onChange;
    await click('Найти в публичных чатах'); expect(h.create).toHaveBeenCalledTimes(1);
    expect.soft(history().disabled).toBe(true);
    await act(async () => {retainedChoice('old-job'); history().onChange('old-job');}); expect.soft(h.read).not.toHaveBeenCalled();
    await act(async () => {ack.resolve(job('accepted-job'));});
    expect(history().value).toBe('accepted-job'); expect(history().disabled).toBe(false); expect(node('Form').disabled).toBe(false);
    await act(async () => {history().onChange('old-job');});
    expect(h.read).toHaveBeenCalledTimes(1); expect(history().value).toBe('old-job');
});

it.each([400, 403, 409])('a confirmed HTTP%s rejection preserves the draft and permits an explicitly revised request with the refreshed pin', async status => {
    h.create.mockRejectedValueOnce({response: {status}, message: 'Проверьте запрос и текущую модель'});
    await render(); await prepare(); await click('Найти в публичных чатах');
    expect(container.textContent).toContain('Вернуться к редактированию'); expect(node('TextArea').value).toBe('Смысловой запрос');
    h.listModels.mockResolvedValue({items: [model('c'.repeat(64))], assignedModelIds: ['model-embed']});
    await click('Вернуться к редактированию'); expect(node('Form').disabled).toBe(false); expect(node('TextArea').value).toBe('Смысловой запрос');
    await click('Обновить модели'); expect(h.listModels).toHaveBeenCalledTimes(2); expect(h.create).toHaveBeenCalledTimes(1);
    h.create.mockResolvedValueOnce(job('revised-job'));
    await act(async () => {node('TextArea').onChange({target: {value: 'Исправленный вопрос'}}); node('Checkbox').onChange({target: {checked: true}});});
    await click('Найти в публичных чатах'); expect(h.create).toHaveBeenCalledTimes(2);
    const first = h.create.mock.calls[0][2], revised = h.create.mock.calls[1][2];
    expect(revised).toMatchObject({query: 'Исправленный вопрос', expectedModelPin: 'c'.repeat(64)});
    expect(revised.requestKey).not.toBe(first.requestKey); expect(history().value).toBe('revised-job');
});

it.each([undefined, 500])('an unconfirmed %s ACK retains the exact request instead of allowing a new paid operation', async status => {
    h.create.mockRejectedValueOnce(status ? {response: {status}} : Error('Network ACK lost'));
    await render(); await prepare(); await click('Найти в публичных чатах');
    expect(container.textContent).not.toContain('Вернуться к редактированию'); expect(node('Form').disabled).toBe(true);
    h.create.mockResolvedValueOnce(job('recovered-job')); await click('Повторить тот же запрос');
    expect(h.create).toHaveBeenCalledTimes(2); expect(h.create.mock.calls[1][2]).toEqual(h.create.mock.calls[0][2]);
    expect(h.listModels).toHaveBeenCalledTimes(1); expect(history().value).toBe('recovered-job'); expect(node('Form').disabled).toBe(false);
});
