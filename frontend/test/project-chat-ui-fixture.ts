import {createElement, type ReactElement, type ReactNode} from 'react';
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
    buttons: new Map<string, () => void>(), inputs: new Map<string, {value: string; disabled?: boolean; onChange: (event: {target: {value: string}}) => void; onKeyDown: (event: unknown) => void}>(),
    selects: new Map<string, {value: string | string[]; disabled?: boolean; onChange: (value: unknown) => void}>(),
    checks: new Map<string, {checked: boolean; disabled?: boolean; onChange: (event: {target: {checked: boolean}}) => void}>(),
    flags: new Map<string, boolean>(), owner: 'alice', scope: 'alice',
}));
const captureOwner = () => {const current = ui.owner; return () => current === ui.owner;};
export {harness, ui};
vi.mock('react', async original => ({...await original<typeof import('react')>(), ...harness, useLayoutEffect: harness.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: ui.scope, captureOwner})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({useFeatureAvailability: (...keys: string[]) => ({enabled: keys.every(key => ui.flags.get(key) !== false), reason: 'Функция выключена администратором'})}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates: () => undefined}));
vi.mock('@ant-design/icons', () => ({SendOutlined: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => createElement('div', null, children);
    const input = (props: {value: string; disabled?: boolean; 'aria-label': string; onChange: (event: {target: {value: string}}) => void; onKeyDown: (event: unknown) => void}) => {
        ui.inputs.set(props['aria-label'], props); return createElement('textarea', {value: props.value, disabled: props.disabled, onChange: props.onChange});
    };
    return {
        Alert: ({message, description, action}: {message?: ReactNode; description?: ReactNode; action?: ReactNode}) => createElement('div', {role: 'alert'}, message, description, action),
        Button: ({children, onClick, disabled, 'aria-label': label}: {children?: ReactNode; onClick?: () => void; disabled?: boolean; 'aria-label'?: string}) => {
            if (onClick && !disabled) ui.buttons.set(label ?? String(children), onClick);
            return createElement('button', {disabled, 'aria-label': label}, children);
        },
        Select: (props: {'aria-label': string; value: string | string[]; disabled?: boolean; onChange: (value: unknown) => void}) => {ui.selects.set(props['aria-label'], props); return null;},
        Checkbox: (props: {children: ReactNode; checked: boolean; disabled?: boolean; onChange: (event: {target: {checked: boolean}}) => void}) => {const label = Array.isArray(props.children) ? props.children.join('') : String(props.children); ui.checks.set(label, props); return createElement('label', null, props.children);},
        Input: {TextArea: input}, Space: content, Spin: content, Empty: ({description}: {description: string}) => createElement('p', null, description), Typography: {Text: content, Paragraph: content, Title: content},
    };
});
export function renderProjectUi(element: () => ReactElement): {element: ReactElement; html: string} {
    harness.begin(); ui.buttons.clear(); ui.inputs.clear(); ui.selects.clear(); ui.checks.clear();
    const value = element(), html = renderToStaticMarkup(value); harness.commit(); return {element: value, html};
}
export async function settleProjectUi(element: () => ReactElement): Promise<ReturnType<typeof renderProjectUi>> {
    for (let index = 0; index < 24; index++) await Promise.resolve(); return renderProjectUi(element);
}
