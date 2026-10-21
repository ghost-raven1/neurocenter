import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {participant} from './model-chat-fixtures';
type Input = {onChange: (event: {target: {value: string}}) => void; onPaste: (event: {clipboardData: {files: File[]}}) => void};
type Mentions = {onChange: (value: string) => void; options: Array<{value: string; label: string}>; filterOption: (search: string, option: {value: string}) => boolean};
const h = await vi.hoisted(async () => {
    const {adminSetupHooks} = await import('./admin-setup-hooks.fixture');
    return {hooks: adminSetupHooks(), input: undefined as Input | undefined, mentions: undefined as Mentions | undefined, dropZone: undefined as Record<string, unknown> | undefined};
});
vi.mock('react', async original => ({...await original<typeof import('react')>(), useRef: h.hooks.ref}));
vi.mock('../src/common/components/FileDropZone/FileDropZone', () => ({FileDropZone: (props: Record<string, unknown>) => { h.dropZone = props; return null; }}));
vi.mock('antd', () => ({Input: {TextArea: (props: Input) => { h.input = props; return null; }}, Mentions: (props: Mentions) => { h.mentions = props; return null; },
    Typography: {Text: ({children}: {children?: ReactNode}) => children}, Button: ({children}: {children?: ReactNode}) => createElement('button', null, children)}));
import {ChatComposer} from '../src/features/ModelChat/ChatComposer';
type Transfer = {types: string[]; items: Array<{kind: string; webkitGetAsEntry?: () => {isDirectory: boolean} | null}>; files: File[]};
type Drag = {dataTransfer: Transfer; preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn>};
type Root = ReactElement<{onDragOver: (event: Drag) => void; onDrop: (event: Drag) => void}>;
const event = (patch: Partial<Transfer> = {}): Drag => ({dataTransfer: {types: ['Files'], items: [], files: [], ...patch}, preventDefault: vi.fn(), stopPropagation: vi.fn()});
let props: Parameters<typeof ChatComposer>[0];
const render = () => { h.hooks.begin(); const tree = ChatComposer(props) as Root; const html = renderToStaticMarkup(tree); h.hooks.commit(); return {tree, html}; };
beforeEach(() => { h.hooks.dispose(); vi.clearAllMocks(); h.input = undefined; h.mentions = undefined; h.dropZone = undefined;
    props = {draft: '', disabled: false, canSend: true, sending: false, uploading: false, onDraft: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onCancelUpload: vi.fn(), onFiles: vi.fn(), onReject: vi.fn()}; });
afterEach(() => h.hooks.dispose());

describe('Composer event boundary: full-area drop and text/mention editing', () => {
    it('only file drag/drop is consumed; a successful batch is delivered exactly once', () => {
        const {tree} = render(), text = event({types: ['text/plain']}), files = [new File(['x'], 'readme.md')]; tree.props.onDragOver(text); tree.props.onDrop(text); expect(text.preventDefault).not.toHaveBeenCalled(); expect(text.stopPropagation).not.toHaveBeenCalled();
        const drag = event({files}); tree.props.onDragOver(drag); expect(drag.preventDefault).toHaveBeenCalledOnce(); tree.props.onDrop(drag); expect(drag.preventDefault).toHaveBeenCalledTimes(2); expect(drag.stopPropagation).toHaveBeenCalledOnce(); expect(props.onFiles).toHaveBeenCalledExactlyOnceWith(files); expect(props.onReject).not.toHaveBeenCalled();
    });
    it('a disabled composer consumes the browser drop without attaching data, and an empty transfer is harmless', () => {
        props.disabled = true; let {tree} = render(); const blocked = event({files: [new File(['private'], 'private.txt')]}); tree.props.onDrop(blocked); expect(blocked.preventDefault).toHaveBeenCalledOnce(); expect(props.onFiles).not.toHaveBeenCalled();
        props.disabled = false; tree = render().tree; tree.props.onDrop(event()); expect(props.onFiles).not.toHaveBeenCalled(); expect(props.onReject).not.toHaveBeenCalled();
    });
    it('directory entries reject the batch, while ordinary/non-file entries use the actual files list', () => {
        const {tree} = render(), files = [new File(['x'], 'source.ts')]; tree.props.onDrop(event({files, items: [{kind: 'file', webkitGetAsEntry: () => ({isDirectory: true})}]})); expect(props.onReject).toHaveBeenCalledExactlyOnceWith('Прикрепите файлы, а не папку.'); expect(props.onFiles).not.toHaveBeenCalled();
        const entry = vi.fn(); tree.props.onDrop(event({files, items: [{kind: 'string', webkitGetAsEntry: entry}, {kind: 'file', webkitGetAsEntry: () => null}, {kind: 'file'}]})); expect(entry).not.toHaveBeenCalled(); expect(props.onFiles).toHaveBeenCalledExactlyOnceWith(files);
    });
    it('a browser transfer read failure yields an actionable rejection instead of losing the drop event', () => {
        const {tree} = render(), broken = event({items: [{kind: 'file', webkitGetAsEntry: () => { throw Error('Browser denied transfer'); }}]}); tree.props.onDrop(broken); expect(props.onReject).toHaveBeenCalledExactlyOnceWith('Не удалось прочитать файлы. Выберите их кнопкой.'); expect(props.onFiles).not.toHaveBeenCalled(); expect(broken.stopPropagation).toHaveBeenCalledOnce();
    });
    it('plain textarea edits and paste use the same callbacks and file picker contract', () => {
        render(); h.input!.onChange({target: {value: 'Новый вопрос'}}); expect(props.onDraft).toHaveBeenCalledExactlyOnceWith('Новый вопрос'); h.input!.onPaste({clipboardData: {files: []}}); expect(props.onFiles).not.toHaveBeenCalled(); const files = [new File(['x'], 'notes.txt')]; h.input!.onPaste({clipboardData: {files}}); expect(props.onFiles).toHaveBeenCalledExactlyOnceWith(files);
        expect(h.dropZone).toMatchObject({multiple: true, disabled: false, busy: false, onFiles: props.onFiles, onReject: props.onReject});
    });
    it('mention search matches active display names and slugs, tolerates an unknown option and forwards edits', () => {
        props.participants = [participant(), participant({agentId: 'blocked', name: 'Недоступный', slug: 'nc-blocked', status: 'blocked'})]; props.draft = '@nc-developer вопрос'; const {html} = render(); expect(h.mentions!.options).toEqual([{value: 'nc-developer', label: 'Разработчик · @nc-developer'}]); expect(html).toContain('Получат: Разработчик');
        expect(h.mentions!.filterOption('РАЗРАБОТ', {value: 'nc-developer'})).toBe(true); expect(h.mentions!.filterOption('DEVELOPER', {value: 'nc-developer'})).toBe(true); expect(h.mentions!.filterOption('unknown', {value: 'unknown'})).toBe(true); expect(h.mentions!.filterOption('другое', {value: 'unknown'})).toBe(false);
        h.mentions!.onChange('@nc-developer продолжение'); expect(props.onDraft).toHaveBeenCalledExactlyOnceWith('@nc-developer продолжение');
    });
});
