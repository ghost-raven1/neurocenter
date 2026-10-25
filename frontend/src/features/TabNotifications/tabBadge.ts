/** A separate local favicon preserves the original nodes, URLs and attributes exactly. */
export function mountTabBadge(document: Document) {
    const title = document.title;
    const original = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map(node => ({node, parent: node.parentNode, next: node.nextSibling}));
    let icon: HTMLLinkElement | undefined, previous = -1;
    const restore = (): void => {
        icon?.remove(); icon = undefined;
        [...original].reverse().forEach(({node, parent, next}) => {if (parent && !node.isConnected) parent.insertBefore(node, next?.parentNode === parent ? next : null);});
        document.title = title;
    };
    return {
        update(count: number): void {
            if (count === previous) return; previous = count;
            if (!count) {restore(); return;}
            document.title = `(${count}) ${title}`;
            if (!icon) {
                original.forEach(({node}) => node.remove());
                icon = document.createElement('link'); icon.rel = 'icon'; icon.type = 'image/svg+xml'; document.head.appendChild(icon);
            }
            icon.href = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#173449"/><path d="M8 24V8l16 16V8" fill="none" stroke="white" stroke-width="3"/><circle cx="25" cy="7" r="7" fill="#f05a58"/></svg>');
        },
        dispose: restore,
    };
}
