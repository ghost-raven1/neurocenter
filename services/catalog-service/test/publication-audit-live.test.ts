import { describe, expect, it, vi } from 'vitest';

import { LiveService } from '../../api-gateway/src/live/live.service';

describe('Обновление открытого журнала после изменения MCP/плагина', () => {
    it.each(['POST', 'PATCH', 'DELETE'])('После %s перечитывает каталог, проекты и аудит без передачи приватных данных', method => {
        const live = new LiveService();
        const emit = vi.fn();
        live.attach({ emit } as never);
        live.mutation('/api/ai-plugins/ai-plug-qa', 'operator@example.test', undefined, method);
        expect(emit).toHaveBeenCalledWith('section:changed', {
            sections: ['catalog', 'projects', 'audit'], at: expect.any(String),
        });
        expect(JSON.stringify(emit.mock.calls)).not.toContain('operator@example.test');
    });
});

describe('Обновление журнала после сохранения исторических ссылок скилла', () => {
    it.each([['POST', '/api/skills'], ['PUT', '/api/skills/common/legacy'], ['DELETE', '/api/skills/common/legacy']])(
        'После %s перечитывает аудит вместе с каталогом', (method, path) => {
            const live = new LiveService();
            const emit = vi.fn();
            live.attach({ emit } as never);
            live.mutation(path, 'operator@example.test', undefined, method);
            expect(emit).toHaveBeenCalledWith('section:changed', {
                sections: ['catalog', 'projects', 'audit'], at: expect.any(String),
            });
        },
    );
});
