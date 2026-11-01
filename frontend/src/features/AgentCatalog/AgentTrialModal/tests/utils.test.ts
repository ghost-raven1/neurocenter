import { describe, expect, it } from 'vitest';
import { agentTrialDate } from '../utils';

describe('agentTrialDate', () => {
    it('shows a readable fallback for an invalid receipt date', () => {
        expect(agentTrialDate('not-a-date')).toBe('Время не указано');
    });
});
