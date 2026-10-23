export const CARD_DEPTH_SELECTOR = '.ant-card, .agent-card, .model-card, .bridge-device-card, .local-installations__item';
const activeClass = 'card-depth_active';
const motionClass = 'card-depth_motion';
const variables = ['--card-depth-x', '--card-depth-y', '--card-depth-base'];

/** Large panels receive a smaller angle so their edges remain within a few pixels. */
export function cardDepthAngles(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, x: number, y: number) {
    const limit = Math.min(1.4, 450 / Math.max(rect.width, rect.height, 1));
    const ratio = (value: number, start: number, size: number) => Math.max(-1, Math.min(1, (value - start) / Math.max(size, 1) * 2 - 1));
    return { x: -ratio(y, rect.top, rect.height) * limit, y: ratio(x, rect.left, rect.width) * limit };
}

/** One delegated listener serves existing and newly rendered cards without changing their controls. */
export function installCardDepth(document: Document): () => void {
    const view = document.defaultView;
    if (!view) return () => undefined;
    const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = view.matchMedia('(hover: hover) and (pointer: fine)');
    const owned = new Map<HTMLElement, { base: string; rect: DOMRect; timer?: number }>();
    let card: HTMLElement | null = null, frame = 0, point = { x: 0, y: 0 };
    const clear = (element: HTMLElement): void => {
        const record = owned.get(element);
        if (record?.timer) view.clearTimeout(record.timer);
        element.classList.remove(activeClass, motionClass);
        variables.forEach(key => element.style.removeProperty(key)); owned.delete(element);
    };
    const reset = (): void => {
        if (frame) view.cancelAnimationFrame(frame);
        frame = 0;
        if (card) {
            const element = card, record = owned.get(element);
            element.classList.remove(activeClass);
            element.style.setProperty('--card-depth-x', '0deg'); element.style.setProperty('--card-depth-y', '0deg');
            if (record) record.timer = view.setTimeout(() => clear(element), 180);
        }
        card = null;
    };
    const clearAll = (): void => { reset(); [...owned.keys()].forEach(clear); };
    const move = (event: PointerEvent): void => {
        if (motion.matches || !pointer.matches || event.pointerType !== 'mouse') { clearAll(); return; }
        if (event.buttons) { reset(); return; }
        const next = event.target instanceof view.Element ? event.target.closest<HTMLElement>(CARD_DEPTH_SELECTOR) : null;
        if (!next || next.matches(':focus-within') || !next.isConnected) { reset(); return; }
        if (card !== next) {
            reset(); card = next;
            const previous = owned.get(card);
            if (previous?.timer) view.clearTimeout(previous.timer);
            // Measure the unrotated hitbox once on entry, never the transformed bounds on each frame.
            card.classList.remove(motionClass);
            const rect = card.getBoundingClientRect(), transform = previous?.base ?? view.getComputedStyle(card).transform;
            const base = transform === 'none' ? 'translateZ(0)' : transform;
            owned.set(card, { base, rect }); card.style.setProperty('--card-depth-base', base);
        }
        point = { x: event.clientX, y: event.clientY };
        if (frame) return;
        frame = view.requestAnimationFrame(() => {
            frame = 0;
            if (!card?.isConnected) { reset(); return; }
            const angles = cardDepthAngles(owned.get(card)!.rect, point.x, point.y);
            card.style.setProperty('--card-depth-x', angles.x.toFixed(3) + 'deg');
            card.style.setProperty('--card-depth-y', angles.y.toFixed(3) + 'deg');
            card.classList.add(motionClass, activeClass);
        });
    };
    const out = (event: PointerEvent): void => {
        if (card && (!(event.relatedTarget instanceof view.Node) || !card.contains(event.relatedTarget))) reset();
    };
    const observer = new view.MutationObserver(() => { if (card && !card.isConnected) clearAll(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', out, { passive: true });
    document.addEventListener('pointerdown', reset, true);
    document.addEventListener('focusin', reset, true);
    document.addEventListener('scroll', reset, true);
    view.addEventListener('blur', reset);
    view.addEventListener('resize', clearAll);
    motion.addEventListener('change', clearAll); pointer.addEventListener('change', clearAll);
    return () => {
        clearAll(); observer.disconnect();
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', out);
        document.removeEventListener('pointerdown', reset, true); document.removeEventListener('focusin', reset, true);
        document.removeEventListener('scroll', reset, true); view.removeEventListener('blur', reset);
        view.removeEventListener('resize', clearAll);
        motion.removeEventListener('change', clearAll); pointer.removeEventListener('change', clearAll);
    };
}
