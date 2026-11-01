import { describe, expect, it } from 'vitest';
import { requestBody } from '../utils.js';
import type { DeviceCodexContext } from '../../contract.js';

const context = (changes: Partial<DeviceCodexContext> = {}): DeviceCodexContext =>
    ({
        model: 'codex',
        options: { store: false },
        messages: [{ role: 'user', content: 'Hello' }],
        ...changes,
    }) as DeviceCodexContext;

describe('Codex request projection', () => {
    it('separates system instructions and always disables response storage', () => {
        expect(
            requestBody(
                context({
                    messages: [
                        { role: 'system', content: 'Be concise' },
                        { role: 'user', content: 'Hello' },
                    ],
                }),
            ),
        ).toEqual({
            model: 'codex',
            instructions: 'Be concise',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
            stream: true,
            store: false,
        });
    });

    it('rejects unsupported options and requests with no conversational input', () => {
        expect(() => requestBody(context({ options: { store: true } }))).toThrow('Параметры');
        expect(() => requestBody(context({ messages: [{ role: 'system', content: 'Only instructions' }] }))).toThrow(
            'не содержит сообщения',
        );
    });
});
