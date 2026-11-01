import { describe, expect, it } from 'vitest';
import { normalizedAgentDefinition } from '../utils';
import type { IAgentDefinition } from '../../interfaces';

describe('normalizedAgentDefinition', () => {
    it('preserves prompt whitespace and zero parameters while trimming metadata', () => {
        const input: IAgentDefinition = {
            description: '  Проверка кода  ',
            prompt: '  # Задача\n\nКод\n',
            mode: 'subagent',
            permission: { read: 'allow' },
            model: '  provider/model  ',
            temperature: 0,
            topP: 0,
            steps: 1,
        };
        const result = normalizedAgentDefinition(input);
        expect(result).toEqual({ ...input, description: 'Проверка кода', model: 'provider/model' });
        expect(input.description).toBe('  Проверка кода  ');
        expect(input.model).toBe('  provider/model  ');
    });

    it('omits an empty model without adding optional parameters', () => {
        const result = normalizedAgentDefinition({
            description: 'Агент',
            prompt: 'Инструкция',
            mode: 'all',
            permission: {},
            model: '   ',
        });
        expect(result).toEqual({ description: 'Агент', prompt: 'Инструкция', mode: 'all', permission: {} });
    });
});
