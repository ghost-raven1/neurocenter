// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement, StrictMode, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Modal} from 'antd';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ChatContextMeter} from '../src/features/ModelChat/ChatContextMeter';
import {ChatResearchControls} from '../src/features/ModelChat/ChatResearchControls';
import {ChatComposer} from '../src/features/ModelChat/ChatComposer';
import {detail} from './model-chat-fixtures';

const send = vi.fn(), closeChat = vi.fn(), researchConsent = vi.fn(), files = vi.fn();
const choices = {project: {available: true}, external: [{assetId: 'search', name: 'Поиск', version: 1, manifest: 'a'.repeat(64), available: true}],
    limits: {stepsPerRecipient: 6, externalCallsPerRound: 16, toolOutputBytes: 65536, gatheredTextBytes: 98304, roundTimeoutMs: 900000}};

/** The real AntD portal and Select participate; this harness supplies no model or network effects. */
function Tools({blocked = false}: {blocked?: boolean}) {
    const [pane, setPane] = useState<string>(), [enabled, setEnabled] = useState(false), [draft, setDraft] = useState('Сохранить этот вопрос');
    const open = (name: string, value: boolean) => setPane(current => value ? name : current === name ? undefined : current);
    return <Modal open footer={null} title="Рабочий чат" onCancel={closeChat} getContainer={false}>
        <div data-testid="conversation"><div role="log">Сохранённая переписка</div>
            <ChatContextMeter context={{...detail().context, exceeded: blocked, canCompact: false, ...(blocked ? {reason: 'Последний документ слишком большой'} : {})}}
                loading={false} open={pane === 'context'} onOpenChange={value => open('context', value)}/>
            <ChatResearchControls projectId="project" disabled={false} open={pane === 'research'} onOpenChange={value => open('research', value)}
                value={{enabled, setEnabled: value => {researchConsent(value); setEnabled(value);}, project: true, setProject: vi.fn(), externalId: undefined, setExternalId: vi.fn(),
                    choices, loading: false, error: '', reason: enabled && blocked ? 'Источник недоступен' : undefined, request: enabled ? {project: true} : undefined, reset: vi.fn(), restore: vi.fn(), reload: vi.fn()}}/>
            <ChatComposer draft={draft} onDraft={setDraft} disabled={false} canSend={!blocked} sending={false} uploading={false} onSend={send} onStop={vi.fn()} onCancelUpload={vi.fn()}
                onFiles={files} onReject={vi.fn()} filesOpen={pane === 'files'} onFilesOpenChange={value => open('files', value)}/>
        </div>
    </Modal>;
}

let container: HTMLDivElement, root: Root;
const settle = async () => {await act(async () => {await new Promise(done => setTimeout(done, 60));});};
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text)!;
const panel = (name: string) => document.querySelector<HTMLElement>(`.model-chat-tool-popover__panel[aria-label="${name}"]`);
async function click(element: HTMLElement) {expect(element).toBeTruthy(); await act(async () => {element.dispatchEvent(new MouseEvent('click', {bubbles: true}));}); await settle();}
async function escape(element: HTMLElement) {await act(async () => {element.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, which: 27, bubbles: true}));}); await settle();}
beforeEach(() => {vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.unstubAllGlobals();});
const render = async (blocked = false) => {await act(async () => {root.render(createElement(StrictMode, null, createElement(Tools, {blocked})));}); await settle();};

describe('Composer panels with the installed AntD portal and keyboard behavior', () => {
    it('opens read-only context outside the chat layout, focuses it and Escape returns to its trigger', async () => {
        await render(); const trigger = button('Оценка контекста'); await click(trigger);
        const context = panel('Оценка контекста')!; expect(context).toBeTruthy(); expect(context.closest('[aria-modal="true"]')).toBeTruthy();
        expect(document.activeElement).toBe(context); expect(document.querySelector('[data-testid="conversation"]')!.contains(context)).toBe(false);
        expect(document.querySelector<HTMLTextAreaElement>('#model-chat-message')!.value).toBe('Сохранить этот вопрос'); expect(button('Отправить').disabled).toBe(false);
        await escape(context); expect(trigger.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger);
        expect(closeChat).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(researchConsent).not.toHaveBeenCalled();
    });
    it('opening settings does not consent, and switching panels keeps one active dialog and the draft', async () => {
        await render(); await click(button('Источники')); expect(panel('Источники')).toBeTruthy(); expect(researchConsent).not.toHaveBeenCalled();
        expect((document.querySelector('.ant-checkbox-input') as HTMLInputElement).checked).toBe(false);
        await click(button('Прикрепить документы')); expect(button('Источники').getAttribute('aria-expanded')).toBe('false'); expect(button('Прикрепить документы').getAttribute('aria-expanded')).toBe('true');
        const input = panel('Прикрепить документы')!.querySelector<HTMLInputElement>('input[type="file"]')!; expect(input.multiple).toBe(true); expect(input.disabled).toBe(false);
        expect(document.querySelector<HTMLTextAreaElement>('#model-chat-message')!.value).toBe('Сохранить этот вопрос'); expect(send).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled();
        await click(button('Закрыть: Прикрепить документы')); expect(document.activeElement).toBe(button('Прикрепить документы')); expect(closeChat).not.toHaveBeenCalled();
    });
    it('the first Escape closes an open Select; the next closes its panel while explicit research consent survives', async () => {
        await render(); await click(document.querySelector<HTMLInputElement>('.ant-checkbox-input')!); expect(researchConsent).toHaveBeenCalledExactlyOnceWith(true);
        const research = panel('Источники')!, select = research.querySelector<HTMLElement>('.ant-select-selector')!;
        await act(async () => {select.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));}); await settle();
        const input = research.querySelector<HTMLInputElement>('[role="combobox"]')!; expect(input.getAttribute('aria-expanded')).toBe('true');
        await escape(input); expect(input.getAttribute('aria-expanded')).toBe('false'); expect(button('Источники').getAttribute('aria-expanded')).toBe('true'); expect(closeChat).not.toHaveBeenCalled();
        await escape(input); expect(button('Источники').getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(button('Источники'));
        expect((document.querySelector('.ant-checkbox-input') as HTMLInputElement).checked).toBe(true); expect(researchConsent).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    });
    it('blocking context and research warnings stay visible with the panels closed', async () => {
        await render(true); const conversation = document.querySelector('[data-testid="conversation"]')!;
        expect(conversation.textContent).toContain('Последний документ слишком большой'); expect(button('Отправить').disabled).toBe(true);
        await click(document.querySelector<HTMLInputElement>('.ant-checkbox-input')!); await click(button('Закрыть: Источники'));
        expect(conversation.textContent).toContain('Источник недоступен'); expect(document.querySelector<HTMLTextAreaElement>('#model-chat-message')!.disabled).toBe(false); expect(send).not.toHaveBeenCalled();
    });
});
