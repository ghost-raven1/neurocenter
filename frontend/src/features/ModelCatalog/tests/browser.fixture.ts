import { vi } from 'vitest';

/** Browser-only layout APIs are irrelevant to modal actions and absent in jsdom. */
export function stubModalBrowser(): void {
    vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    );
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
}
