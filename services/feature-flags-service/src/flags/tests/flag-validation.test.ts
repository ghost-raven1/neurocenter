import { describe, expect, it } from 'vitest';
import { featureFlagPatch } from '../flag-validation';

describe('featureFlagPatch', () => {
    it('retains an explicit disable and the revision used for conflict detection', () => {
        expect(featureFlagPatch({ enabled: false, expectedRevision: 7 })).toEqual({
            enabled: false,
            expectedRevision: 7,
        });
    });
    it.each([
        null,
        [],
        { enabled: 'false', expectedRevision: 1 },
        { enabled: true },
        { enabled: true, expectedRevision: 0 },
        { enabled: true, expectedRevision: 1.5 },
        { enabled: true, expectedRevision: 1, actor: 'admin' },
    ])('rejects malformed updates: %j', (value) => {
        expect(() => featureFlagPatch(value)).toThrow();
    });
});
