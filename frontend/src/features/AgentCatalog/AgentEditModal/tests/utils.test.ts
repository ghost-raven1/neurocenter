import { agentSlugPattern } from '../../constants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialAgentSlug } from '../utils';

describe('initialAgentSlug', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('creates a slug usable by OpenCode', () => {
        vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789012' });
        expect(initialAgentSlug()).toMatch(agentSlugPattern);
    });

    it('keeps manual slug entry available when crypto is unavailable', () => {
        vi.stubGlobal('crypto', undefined);
        expect(initialAgentSlug()).toBe('');
    });
});
