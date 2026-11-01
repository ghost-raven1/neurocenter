import { describe, expect, it } from 'vitest';
import { publicResearchUrl, researchArguments } from '../research-tools';

describe('research-tools', () => {
    it('normalizes a public URL and removes the fragment', () => {
        expect(publicResearchUrl('https://example.com/docs#intro')).toBe('https://example.com/docs');
    });
    it.each([
        'http://127.0.0.1',
        'http://localhost',
        'https://example.internal',
        'file:///etc/passwd',
        'https://user:pass@example.com',
        'https://example.com:8080',
    ])('rejects unsupported research targets: %s', (url) => {
        expect(publicResearchUrl(url)).toBeUndefined();
    });
    it('does not allow a model to choose an arbitrary mutation tool', () => {
        expect(() => researchArguments('delete_project', { id: 'prj-example' })).toThrow();
    });
});
