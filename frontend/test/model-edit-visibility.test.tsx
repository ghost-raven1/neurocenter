// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelEditModal} from '../src/features/ModelCatalog/ModelEditModal';
import {modelCatalogApi} from '../src/features/ModelCatalog/api';

vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: () => () => true})}));
vi.mock('../src/features/ModelCatalog/api', () => ({modelCatalogApi: {create: vi.fn(), update: vi.fn()}}));
vi.mock('../src/features/McpBridge/bridgeRequestKey', () => ({createBridgeRequestKey: () => '11111111-1111-4111-8111-111111111111'}));
let root: Root, host: HTMLDivElement;
const saved = vi.fn(), close = vi.fn();
const settle = async (): Promise<void> => {await act(async () => {for (let n = 0; n < 20; n++) await Promise.resolve();});};
async function change(name: string, value: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('#model-catalog-edit_' + name)!;
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => {Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
}
async function render(): Promise<void> {await act(async () => {root.render(createElement(ModelEditModal, {connectApi: true, onClose: close, onSaved: saved}));}); await settle();}
beforeEach(() => {
    vi.clearAllMocks(); Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
    const getStyle = window.getComputedStyle; vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element));
    window.matchMedia = vi.fn().mockImplementation(() => ({matches: false, addListener: vi.fn(), removeListener: vi.fn()}));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();});

describe('Model editor keeps its next action separate from scrolling fields', () => {
    it('keeps submit and cancel in the modal footer and submits the associated form', async () => {
        await render();
        const submit = document.querySelector<HTMLButtonElement>('.ant-modal-footer button[type="submit"]');
        expect(submit).toBeTruthy(); expect(submit!.closest('.ant-modal-body')).toBeNull();
        expect(submit!.form?.id).toBe('model-catalog-edit');
        await change('name', 'Test API'); await change('model', 'namespace/model'); await change('modelVersion', 'v1');
        vi.mocked(modelCatalogApi.create).mockRejectedValueOnce(new Error('Контрольный отказ'));
        await act(async () => submit!.click()); await settle();
        expect(modelCatalogApi.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: 'Test API', model: 'namespace/model', modelVersion: 'v1'}), '11111111-1111-4111-8111-111111111111');
        expect(document.querySelector('.ant-modal-footer [role="alert"]')?.textContent).toContain('Контрольный отказ');
        expect(document.querySelector<HTMLInputElement>('#model-catalog-edit_name')!.value).toBe('Test API');
        expect(close).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
        await act(async () => submit!.click()); await settle();
        expect(modelCatalogApi.create.mock.calls[1]).toEqual(modelCatalogApi.create.mock.calls[0]);
    });
    it('starts optional description collapsed and preserves it through an API failure', async () => {
        await render();
        const optional = document.querySelector<HTMLDetailsElement>('.model-editor__optional');
        expect(optional).toBeTruthy(); expect(optional!.open).toBe(false);
        await act(async () => optional!.querySelector('summary')!.click());
        expect(optional!.open).toBe(true);
        await change('description', '  Notes remain  '); await change('name', 'Test API'); await change('model', 'namespace/model'); await change('modelVersion', 'v1');
        vi.mocked(modelCatalogApi.create).mockRejectedValueOnce(new Error('Отказ'));
        await act(async () => document.querySelector<HTMLButtonElement>('.ant-modal-footer button[type="submit"]')!.click()); await settle();
        expect(modelCatalogApi.create).toHaveBeenCalledWith(expect.objectContaining({description: 'Notes remain'}), expect.any(String));
        expect(document.querySelector<HTMLTextAreaElement>('#model-catalog-edit_description')!.value).toBe('  Notes remain  ');
    });
});
