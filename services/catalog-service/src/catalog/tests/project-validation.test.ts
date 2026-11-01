import { describe, expect, it } from 'vitest';
import { validateProjectRetention } from '../project-validation';

describe('validateProjectRetention', () => {
    it.each([1, 100])('accepts the supported boundary %s', (retention) => {
        expect(validateProjectRetention({ retention })).toBe(retention);
    });
    it.each([0, 101, 1.5, '3', null])('rejects an invalid retention: %j', (retention) => {
        expect(() => validateProjectRetention({ retention })).toThrow();
    });
    it('does not accept unrelated project changes on the retention route', () => {
        expect(() => validateProjectRetention({ retention: 3, name: 'Renamed' })).toThrow();
    });
});
