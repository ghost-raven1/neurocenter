// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mountTabBadge} from '../src/features/TabNotifications/tabBadge';

let head: string;
beforeEach(() => {head = document.head.innerHTML; document.head.innerHTML = '<title>Нейроцентр</title><link rel="shortcut icon" href="/old.svg?v=exact&amp;x=1" sizes="32x32"><meta name="test" content="keep"><link rel="icon" href="/second.ico" type="image/x-icon">';});
afterEach(() => {document.head.innerHTML = head;});

describe('Browser-owned title and favicon', () => {
    it('shows confirmed source activity without fetching or mutating the original favicon nodes', () => {
        const originals = [...document.querySelectorAll('link')], markup = originals.map(node => node.outerHTML); const badge = mountTabBadge(document);
        badge.update(2); expect(document.title).toBe('(2) Нейроцентр');
        const active = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!; expect(active.href.startsWith('data:image/svg+xml,')).toBe(true);
        expect(originals.map(node => node.outerHTML)).toEqual(markup);
        badge.update(0); expect(document.title).toBe('Нейроцентр'); expect([...document.querySelectorAll('link')]).toEqual(originals); badge.dispose();
    });
    it('OFF/unmount restores exact href attributes, relative node order and the original title', () => {
        const before = document.head.innerHTML, originals = [...document.querySelectorAll('link')];
        const badge = mountTabBadge(document); badge.update(1); badge.update(4); badge.dispose(); badge.dispose();
        expect(document.head.innerHTML).toBe(before); expect([...document.querySelectorAll('link')]).toEqual(originals); expect(document.title).toBe('Нейроцентр');
    });
    it('a fresh StrictMode mount starts from the restored document rather than nesting count prefixes', () => {
        const first = mountTabBadge(document); first.update(1); first.dispose();
        const replay = mountTabBadge(document); replay.update(3); expect(document.title).toBe('(3) Нейроцентр'); replay.dispose(); expect(document.title).toBe('Нейроцентр');
    });
});
