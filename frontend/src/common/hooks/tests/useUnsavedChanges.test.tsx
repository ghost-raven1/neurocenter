// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUnsavedChanges } from '../useUnsavedChanges';

const navigation = vi.hoisted(() => ({ block: vi.fn(), unblock: vi.fn() }));
vi.mock('react-router-dom', () => ({ useHistory: () => navigation }));

let root: Root;
let container: HTMLDivElement;
function Draft({ dirty }: { dirty: boolean }): null {
    useUnsavedChanges(dirty, 'Discard unsaved edits?');
    return null;
}
function closingIsPrevented(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    navigation.block.mockReset().mockReturnValue(navigation.unblock);
    navigation.unblock.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
it('protects dirty edits and releases navigation and browser closing after saving', () => {
    act(() => root.render(<Draft dirty={false} />));
    expect(navigation.block).not.toHaveBeenCalled();
    expect(closingIsPrevented()).toBe(false);
    act(() => root.render(<Draft dirty />));
    expect(navigation.block).toHaveBeenCalledWith('Discard unsaved edits?');
    expect(closingIsPrevented()).toBe(true);
    act(() => root.render(<Draft dirty={false} />));
    expect(navigation.unblock).toHaveBeenCalledOnce();
    expect(closingIsPrevented()).toBe(false);
});
it('releases protection when the editor unmounts', () => {
    act(() => root.render(<Draft dirty />));
    act(() => root.render(null));
    expect(navigation.unblock).toHaveBeenCalledOnce();
    expect(closingIsPrevented()).toBe(false);
});
