import {createElement, isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {vi} from 'vitest';

const harness = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));
    return {
        begin: () => {cursor = 0;}, commit: () => effects.splice(0).forEach(effect => effect()),
        dispose: () => {slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0;},
        useState<T>(initial: T | (() => T)) {const slot = slots[cursor++] ??= {value: typeof initial === 'function' ? (initial as () => T)() : initial}; return [slot.value, (next: T | ((old: T) => T)) => {slot.value = typeof next === 'function' ? (next as (old: T) => T)(slot.value as T) : next;}];},
        useRef<T>(initial: T) {return (slots[cursor++] ??= {value: {current: initial}}).value;},
        useCallback<T>(value: T, deps: unknown[]) {const index = cursor++, previous = slots[index]; if (!previous || !same(previous.deps, deps)) slots[index] = {value, deps}; return slots[index].value;},
        useEffect(effect: () => void | (() => void), deps: unknown[]) {const index = cursor++, previous = slots[index]; if (previous && same(previous.deps, deps)) return; const slot = slots[index] = {deps}; effects.push(() => {previous?.cleanup?.(); slot.cleanup = effect() || undefined;});},
    };
});
const ui = vi.hoisted(() => ({
    buttons: new Map<string, () => void>(), inputs: new Map<string, {value: string; disabled?: boolean; onChange: (event: {target: {value: string}}) => void}>(),
    confirmations: [] as Array<() => void>, flags: new Map<string, boolean>(), owns: true, scope: 'actor-a',
}));
const owns = () => ui.owns, captureOwner = () => owns;
export {harness, ui};
vi.mock('react', async original => ({...await original<typeof import('react')>(), ...harness}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: ui.scope, captureOwner})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: (...keys: string[]) => ({enabled: keys.every(key => ui.flags.get(key) !== false), reason: 'Функция выключена администратором'})}));
vi.mock('../src/common/components/AccessibleDrawer', () => ({default: ({children, open}: {children?: ReactNode; open?: boolean}) => open ? children : null}));
vi.mock('@ant-design/icons', () => Object.fromEntries(['PaperClipOutlined', 'SendOutlined', 'FileOutlined', 'UserOutlined', 'ReloadOutlined', 'HeartFilled', 'HeartOutlined', 'MessageOutlined', 'DownloadOutlined', 'UploadOutlined'].map(name => [name, () => null])));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => createElement('div', null, children);
    const input = (props: {value: string; disabled?: boolean; 'aria-label'?: string; id?: string; onChange: (event: {target: {value: string}}) => void}) => {
        ui.inputs.set(props['aria-label'] ?? props.id ?? '', props); return createElement('textarea', {value: props.value, disabled: props.disabled, onChange: props.onChange});
    };
    const empty = Object.assign(content, {PRESENTED_IMAGE_SIMPLE: null});
    return {
        Alert: ({message, description, action}: {message?: ReactNode; description?: ReactNode; action?: ReactNode}) => createElement('div', {role: 'alert'}, message, description, action),
        Button: ({children, onClick, disabled, 'aria-label': label, 'aria-pressed': pressed}: {children?: ReactNode; onClick?: () => void; disabled?: boolean; 'aria-label'?: string; 'aria-pressed'?: boolean}) => {
            const name = label ?? String(children); if (onClick && !disabled) ui.buttons.set(name, onClick);
            return createElement('button', {disabled, 'aria-label': label, 'aria-pressed': pressed}, children);
        },
        Input: Object.assign(input, {TextArea: input}), Avatar: content, Space: content, Spin: content, Empty: empty, Tooltip: content,
        Progress: ({percent}: {percent: number}) => createElement('span', null, percent),
        Popconfirm: ({children, disabled, onConfirm}: {children?: ReactNode; disabled?: boolean; onConfirm: () => void}) => {if (!disabled) ui.confirmations.push(onConfirm); return children;},
        Modal: ({children}: {children?: ReactNode}) => children,
        Tabs: ({items}: {items: Array<{key: string; children: ReactNode}>}) => createElement('div', null, items.map(item => createElement('div', {key: item.key}, item.children))),
        Typography: {Text: content, Paragraph: content, Title: content},
    };
});

export function renderUi(element: () => ReactElement): {element: ReactElement; html: string} {
    harness.begin(); ui.buttons.clear(); ui.inputs.clear(); ui.confirmations.length = 0;
    const value = element(), html = renderToStaticMarkup(value); harness.commit(); return {element: value, html};
}
export async function settleUi(element: () => ReactElement): Promise<ReturnType<typeof renderUi>> {
    for (let index = 0; index < 24; index++) await Promise.resolve();
    return renderUi(element);
}
export function nativeInput(element: ReactElement): {onChange: (event: {target: {files: File[]; value: string}}) => void} {
    const visit = (value: ReactNode): ReactElement | undefined => {
        if (!isValidElement<{children?: ReactNode; type?: string}>(value)) return;
        if (value.type === 'input' && value.props.type === 'file') return value;
        for (const child of Array.isArray(value.props.children) ? value.props.children : [value.props.children]) {const found = visit(child); if (found) return found;}
    };
    const found = visit(element); if (!found) throw new Error('Missing native file picker'); return found.props as ReturnType<typeof nativeInput>;
}
