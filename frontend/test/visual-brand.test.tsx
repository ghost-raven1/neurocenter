import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from '../src/common/components/BrandMark';
import { NeuralBackdrop } from '../src/features/Appearance/NeuralBackdrop';

describe('Shared visual identity', () => {
    it('uses the same existing vector in the interface and browser tab', () => {
        const mark = renderToStaticMarkup(createElement(BrandMark));
        const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
        expect(mark).toContain('src="/brand-mark.svg"'); expect(index).toMatch(/rel="icon"[^>]+href="\/brand-mark\.svg\?/);
        expect(readFileSync(new URL('../public/brand-mark.svg', import.meta.url), 'utf8')).toContain('<svg');
        expect(mark).toContain('alt=""'); expect(mark).toContain('aria-hidden="true"');
    });
    it('keeps the neural field decorative without controls or external image requests', () => {
        const html = renderToStaticMarkup(createElement(NeuralBackdrop));
        expect(html).toContain('aria-hidden="true"'); expect(html).toContain('neural-backdrop__signals');
        expect(html).not.toMatch(/<button|tabindex|<image|https?:|<foreignObject/i);
    });
});
