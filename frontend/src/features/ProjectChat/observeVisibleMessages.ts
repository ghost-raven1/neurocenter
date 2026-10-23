import {chatWindowActive} from '../ChatActivity/session';

/** Only unobscured human messages in the focused viewport can become read receipts. */
export function observeVisibleMessages(viewport: HTMLElement, onVisible: (ids: string[], currentVisible?: () => string[]) => void): () => void {
    if (typeof IntersectionObserver === 'undefined') return () => undefined;
    const intersecting = new Set<HTMLElement>();
    const currentVisible = (): string[] => {
        if (!chatWindowActive()) return [];
        const root = viewport.getBoundingClientRect(), ids: string[] = [];
        for (const node of intersecting) {
            const rect = node.getBoundingClientRect();
            const left = Math.max(root.left, rect.left, 0), right = Math.min(root.right, rect.right, window.innerWidth);
            const top = Math.max(root.top, rect.top, 0), bottom = Math.min(root.bottom, rect.bottom, window.innerHeight);
            if (right <= left || bottom - top < Math.min(48, rect.height / 2)) continue;
            const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
            if (hit && node.contains(hit) && node.dataset.chatMessageId) ids.push(node.dataset.chatMessageId);
        }
        return ids;
    };
    const check = (): void => onVisible(currentVisible(), currentVisible);
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const node = entry.target as HTMLElement;
            if (entry.isIntersecting) intersecting.add(node); else intersecting.delete(node);
        }
        check();
    }, {root: viewport, threshold: [0, 0.1, 0.5, 1]});
    viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]').forEach(node => observer.observe(node));
    // Recheck occlusion after a modal closes without changing the article's geometry.
    const timer = setInterval(check, 750);
    viewport.addEventListener('scroll', check); window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => {
        observer.disconnect(); clearInterval(timer); viewport.removeEventListener('scroll', check); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check);
    };
}
