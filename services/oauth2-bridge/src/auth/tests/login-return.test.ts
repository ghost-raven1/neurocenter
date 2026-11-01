import { describe, expect, it } from 'vitest';
import { loginReturn } from '../login-return';

describe('loginReturn', () => {
    it('keeps the setup route and query after login', () => {
        expect(loginReturn('/start/connect?project=prj-example#credentials')).toBe(
            '/start/connect?project=prj-example',
        );
    });
    it.each(['https://example.com', '//example.com', '/\\example.com', '/admin', '/start evil', null])(
        'rejects unsafe or unsupported return routes: %s',
        (value) => {
            expect(loginReturn(value)).toBe('/');
        },
    );
});
