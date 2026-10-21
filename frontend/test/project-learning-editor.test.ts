import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LearningEditorModal} from '../src/features/ProjectLearning/LearningEditorModal';
import type {LearningEditorState} from '../src/features/ProjectLearning/types';
import {flushLearning, learningHooks} from './project-learning-hooks';

const hooks = vi.hoisted(() => ({current: undefined as ReturnType<typeof learningHooks> | undefined}));
const ui = vi.hoisted(() => ({finish: undefined as ((value: {content: string}) => void) | undefined, change: undefined as (() => void) | undefined, cancel: undefined as (() => void) | undefined,
    confirm: undefined as {onOk: () => void} | undefined, buttons: new Map<string, () => void>(), dirty: false}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
    useState: (...args: Parameters<ReturnType<typeof learningHooks>['useState']>) => hooks.current!.useState(...args), useRef: (...args: Parameters<ReturnType<typeof learningHooks>['useRef']>) => hooks.current!.useRef(...args), useEffect: (...args: Parameters<ReturnType<typeof learningHooks>['useEffect']>) => hooks.current!.useEffect(...args)}));
vi.mock('../src/features/ProjectLearning/useUnsavedLearning', () => ({useUnsavedLearning: (dirty: boolean) => {ui.dirty = dirty;}}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Modal: Object.assign(({children, onCancel}: {children?: ReactNode; onCancel: () => void}) => {ui.cancel = onCancel; return children;}, {confirm: (value: typeof ui.confirm) => {ui.confirm = value; return {destroy: () => undefined};}}),
        Form: Object.assign(({children, onFinish, onValuesChange}: {children?: ReactNode; onFinish: typeof ui.finish; onValuesChange: typeof ui.change}) => {ui.finish = onFinish; ui.change = onValuesChange; return children;}, {useForm: () => [{}]}),
        Space: content, Typography: {Paragraph: content}, Alert: ({message, description}: {message: ReactNode; description?: ReactNode}) => createElement('div', null, message, description),
        Button: ({children, onClick}: {children?: ReactNode; onClick?: () => void}) => {if (onClick) ui.buttons.set(Array.isArray(children) ? children.join('') : String(children), onClick); return children;},
    };
});
const onClose = vi.fn(), onSubmit = vi.fn();
let revision: number, state: LearningEditorState;
function render() {hooks.current!.begin(); ui.buttons.clear(); const html = renderToStaticMarkup(createElement(LearningEditorModal<{content: string}>, {title: 'Candidate', submitText: 'Сохранить', currentRevision: revision, state, initialValues: {content: 'Initial'}, onClose, onSubmit}, createElement('input'))); hooks.current!.commit(); return html;}
beforeEach(() => {vi.clearAllMocks(); hooks.current = learningHooks(); ui.finish = undefined; ui.change = undefined; ui.cancel = undefined; ui.confirm = undefined; ui.dirty = false; revision = 3; state = {busy: false, error: '', conflict: false, unconfirmed: false}; onSubmit.mockResolvedValue(true);});
afterEach(() => hooks.current?.dispose());

describe('Learning draft preservation and explicit conflict review', () => {
    it('Closes only after a confirmed submission and preserves exact whitespace', async () => {
        render(); const value = {content: '  # Draft\n\nС отступами  '}; ui.finish!(value); await flushLearning(); expect(onSubmit).toHaveBeenCalledExactlyOnceWith(value, 3); expect(onClose).toHaveBeenCalledOnce();
    });
    it('A declined/failed mutation leaves the form open with its draft', async () => {onSubmit.mockResolvedValue(false); render(); ui.finish!({content: 'Draft'}); await flushLearning(); expect(onClose).not.toHaveBeenCalled();});
    it('A CAS conflict does not silently rebase an editor; the user explicitly adopts the new revision', async () => {
        render(); ui.change!(); revision = 4; state = {...state, conflict: true, error: 'Изменилось'}; expect(render()).toContain('Ваш текст сохранён');
        ui.finish!({content: 'My draft'}); await flushLearning(); expect(onSubmit).not.toHaveBeenCalled();
        ui.buttons.get('Использовать актуальную ревизию 4')!(); render(); ui.finish!({content: 'My draft'}); await flushLearning(); expect(onSubmit).toHaveBeenCalledExactlyOnceWith({content: 'My draft'}, 4);
    });
    it('Dirty navigation asks whether to discard, while a busy submit cannot close', () => {
        render(); ui.change!(); render(); expect(ui.dirty).toBe(true); ui.cancel!(); expect(onClose).not.toHaveBeenCalled(); expect(ui.confirm).toBeDefined(); ui.confirm!.onOk(); expect(onClose).toHaveBeenCalledOnce();
        onClose.mockClear(); state = {...state, busy: true}; render(); ui.cancel!(); expect(onClose).not.toHaveBeenCalled();
    });
    it('Unknown writes cannot be submitted again through a direct form callback; the user can reach receipt recovery', async () => {
        state = {...state, unconfirmed: true}; expect(render()).toContain('Квитанция с исходным текстом сохранена'); ui.finish!({content: 'Draft'}); await flushLearning(); expect(onSubmit).not.toHaveBeenCalled();
        ui.cancel!(); expect(onClose).toHaveBeenCalledOnce();
    });
});
