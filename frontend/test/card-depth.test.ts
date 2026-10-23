import { describe, expect, it, vi } from 'vitest';
import { cardDepthAngles, installCardDepth } from '../src/features/CardDepth/motion';

/** Small event surface controls frame/media timing; browser proof separately checks real layout and CSS. */
function fixture() {
    const callbacks = new Map<string, EventListener>();
    const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
    class Node { parent: Node | null = null; }
    class Element extends Node {
        isConnected = true; focused = false; classes = new Set<string>(); values = new Map<string, string>();
        closestCard: Element | null = this;
        classList = { add: (...values: string[]) => values.forEach(value=>this.classes.add(value)), remove: (...values: string[]) => values.forEach(value=>this.classes.delete(value)) };
        style = { setProperty: (key: string, value: string) => this.values.set(key, value), removeProperty: (key: string) => this.values.delete(key) };
        closest() { return this.closestCard; }
        matches() { return this.focused; }
        contains(node: Node): boolean { return node === this || !!node.parent && this.contains(node.parent); }
        getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
    }
    const media = [false, true].map(matches => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    let changed: () => void = () => undefined;
    const view = { Element, Node, matchMedia: vi.fn().mockImplementationOnce(() => media[0]).mockImplementationOnce(() => media[1]),
        requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
        cancelAnimationFrame: (id: number) => frames.delete(id), getComputedStyle: () => ({ transform: 'matrix(1, 0, 0, 1, 2, 0)' }),
        setTimeout: vi.fn(()=>123), clearTimeout: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), MutationObserver: class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect() {} } };
    const document = { defaultView: view, documentElement: {}, addEventListener: (key: string, callback: EventListener) => callbacks.set(key, callback),
        removeEventListener: (key: string) => callbacks.delete(key) };
    const stop = installCardDepth(document as never), card = new Element();
    const emit = (key: string, extra: Record<string, unknown> = {}) => callbacks.get(key)?.({ target: card, pointerType: 'mouse', buttons: 0, clientX: 300, clientY: 0, ...extra } as unknown as Event);
    const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); };
    return { stop, card, Element, media, callbacks, frames, emit, flush, removed: () => changed() };
}

describe('Bounded subtle card motion', () => {
    it('centres the card, clamps outside points and reduces the angle of large panels', () => {
        expect(cardDepthAngles({ left: 10, top: 20, width: 200, height: 100 }, 110, 70)).toEqual({ x: -0, y: 0 });
        expect(cardDepthAngles({ left: 0, top: 0, width: 200, height: 100 }, 999, -999)).toEqual({ x: 1.4, y: 1.4 });
        expect(cardDepthAngles({ left: 0, top: 0, width: 900, height: 800 }, 900, 0)).toEqual({ x: .5, y: .5 });
    });
    it('coalesces mouse movement and preserves a pre-existing transform', () => {
        const f = fixture(); f.emit('pointermove'); f.emit('pointermove', { clientX: 0 });
        expect(f.frames.size).toBe(1); f.flush();
        expect(f.card.values.get('--card-depth-y')).toBe('-1.400deg');
        expect(f.card.values.get('--card-depth-base')).toContain('matrix'); expect(f.card.classes.has('card-depth_active')).toBe(true); f.stop();
    });
    it('uses a stable unrotated rectangle while the pointer crosses a card', () => {
        const f = fixture(), measure = vi.spyOn(f.card, 'getBoundingClientRect');
        f.emit('pointermove'); f.flush(); f.emit('pointermove', { clientX: 20 }); f.flush();
        expect(measure).toHaveBeenCalledTimes(1); f.stop();
    });
    it('moves only the nearest card and clears the outer card on entry', () => {
        const f = fixture(); f.emit('pointermove'); f.flush();
        const child = new f.Element(); child.parent = f.card;
        f.emit('pointermove', { target: child }); f.flush();
        expect(child.classes.has('card-depth_active')).toBe(true); expect(f.card.classes.has('card-depth_active')).toBe(false); f.stop();
    });
    it.each(['touch', 'pen'])('keeps %s interaction static', pointerType => {
        const f = fixture(); f.emit('pointermove', { pointerType }); f.flush(); expect(f.card.classes.size).toBe(0); f.stop();
    });
    it('honours reduced motion, coarse pointers and focused controls immediately', () => {
        const f = fixture();
        f.media[0].matches = true; f.emit('pointermove'); f.flush(); expect(f.card.classes.size).toBe(0);
        f.media[0].matches = false; f.media[1].matches = false; f.emit('pointermove'); f.flush(); expect(f.card.classes.size).toBe(0);
        f.media[1].matches = true; f.card.focused = true; f.emit('pointermove'); f.flush(); expect(f.card.classes.size).toBe(0); f.stop();
    });
    it('removes all owned styles and a pending frame on disable or navigation', () => {
        const f = fixture(); f.emit('pointermove'); f.flush(); f.card.isConnected = false; f.removed();
        expect(f.card.values.size).toBe(0); f.card.isConnected = true; f.emit('pointermove'); f.stop(); f.flush();
        expect(f.card.classes.size).toBe(0); expect(f.card.values.size).toBe(0); expect(f.callbacks.size).toBe(0);
    });
    it.each(['pointerdown', 'focusin', 'scroll'])('stabilizes the card before %s', event => {
        const f = fixture(); f.emit('pointermove'); f.flush(); f.emit(event); expect(f.card.classes.has('card-depth_active')).toBe(false); expect(f.card.values.get('--card-depth-x')).toBe('0deg'); f.stop();
    });
});
