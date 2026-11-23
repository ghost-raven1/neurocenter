// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FC, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    reportClientError: vi.fn(),
}));

vi.mock('../reportClientError', () => ({
    reportClientError: mocks.reportClientError,
}));

import ErrorBoundary from '../ErrorBoundary';

const ThrowingChild: FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
    if (shouldThrow) {
        throw new Error('render secret detail');
    }
    return <div>дети целы</div>;
};

const Harness: FC = () => {
    const [shouldThrow, setShouldThrow] = useState(false);
    (Harness as unknown as { set: (value: boolean) => void }).set = setShouldThrow;
    return <ThrowingChild shouldThrow={shouldThrow} />;
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    mocks.reportClientError.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('ErrorBoundary (AD-O5 6.11)', () => {
    it('render-ошибка → репорт (safe-поля) + fallback, страница не падает', async () => {
        await act(async () => {
            root.render(
                <ErrorBoundary>
                    <Harness />
                </ErrorBoundary>,
            );
        });
        expect(container.textContent).toContain('дети целы');
        expect(mocks.reportClientError).not.toHaveBeenCalled();

        await act(async () => {
            (Harness as unknown as { set: (value: boolean) => void }).set(true);
        });

        expect(container.textContent).toContain('Что-то пошло не так');
        expect(mocks.reportClientError).toHaveBeenCalledTimes(1);
        const input = mocks.reportClientError.mock.calls[0][0];
        expect(input.kind).toBe('render');
        expect(input.component).toBe('ThrowingChild');
        expect(typeof input.stackHint).toBe('string');
        // AD-O8: error.message в репорт не уходит (и в UI fallback нет).
        expect(JSON.stringify(input)).not.toContain('render secret detail');
        expect(container.textContent).not.toContain('render secret detail');
    });

    it('без ошибки дети рендерятся, репортов нет', async () => {
        await act(async () => {
            root.render(
                <ErrorBoundary>
                    <ThrowingChild shouldThrow={false} />
                </ErrorBoundary>,
            );
        });
        expect(container.textContent).toContain('дети целы');
        expect(mocks.reportClientError).not.toHaveBeenCalled();
    });
});
