// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    reportClientError: vi.fn(),
}));

vi.mock('../reportClientError', () => ({
    reportClientError: mocks.reportClientError,
}));

import { installWindowHandlers } from '../windowHandlers';

/** jsdom не реализует PromiseRejectionEvent: собираем событие с тем же полем, которое читает обработчик. */
const rejectionEvent = (reason: unknown): Event => {
    const event = new Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(event, 'reason', { value: reason });
    return event;
};

describe('installWindowHandlers (AD-O5 6.11)', () => {
    let dispose: (() => void) | undefined;

    beforeEach(() => {
        mocks.reportClientError.mockReset();
        dispose = installWindowHandlers();
    });

    afterEach(() => {
        dispose?.();
        dispose = undefined;
    });

    it('window error (runtime-исключение) → репорт uncaught, без error.message', () => {
        const error = new Error('secret runtime detail');
        error.stack = 'Error: secret runtime detail\n    at boom (app.js:7:3)';
        window.dispatchEvent(new window.ErrorEvent('error', { error, message: 'secret runtime detail' }));

        expect(mocks.reportClientError).toHaveBeenCalledTimes(1);
        const input = mocks.reportClientError.mock.calls[0][0];
        expect(input.kind).toBe('uncaught');
        expect(input.stackHint).toBe('at boom (app.js:7:3)');
        expect(JSON.stringify(input)).not.toContain('secret runtime detail');
    });

    it('window error без Error-объекта (ресурс) → репорт без hint', () => {
        window.dispatchEvent(new window.ErrorEvent('error', { message: 'Script error.' }));
        expect(mocks.reportClientError).toHaveBeenCalledTimes(1);
        expect(mocks.reportClientError.mock.calls[0][0]).toEqual({ kind: 'uncaught', stackHint: undefined });
    });

    it('unhandledrejection с Error → репорт rejection, кадры без message', () => {
        const reason = new Error('rejected with secret');
        reason.stack = 'Error: rejected with secret\n    at fail (lib.js:9:1)';
        window.dispatchEvent(rejectionEvent(reason));

        expect(mocks.reportClientError).toHaveBeenCalledTimes(1);
        const input = mocks.reportClientError.mock.calls[0][0];
        expect(input.kind).toBe('rejection');
        expect(input.stackHint).toBe('at fail (lib.js:9:1)');
        expect(JSON.stringify(input)).not.toContain('rejected with secret');
    });

    it('unhandledrejection со строкой (payload) → только тип, значение не уходит', () => {
        window.dispatchEvent(rejectionEvent('user payload secret'));
        expect(mocks.reportClientError).toHaveBeenCalledTimes(1);
        const input = mocks.reportClientError.mock.calls[0][0];
        expect(input.kind).toBe('rejection');
        expect(input.stackHint).toBe('Error: string');
        expect(JSON.stringify(input)).not.toContain('user payload secret');
    });

    it('cleanup снимает обработчики', () => {
        dispose?.();
        window.dispatchEvent(rejectionEvent(new Error('after cleanup')));
        expect(mocks.reportClientError).not.toHaveBeenCalled();
    });
});
