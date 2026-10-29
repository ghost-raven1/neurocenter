import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {agentUpdate, showAgentUpdate} from '../src/features/AgentCatalog/agentUpdates';
import {projectAgentStatus} from '../src/features/AgentCatalog/model';
import {AgentCard} from '../src/features/AgentCatalog/AgentCard';
import {agent, assignment, catalog, delivery, target} from './agent-fixtures';

describe('Обновление шаблона не подменяет квитанцию OpenCode', () => {
    it('Сохраняет различие между head v2, проектом v1 и подтверждённым шаблоном v1', () => {
        const latest = agent({version: 2}), pin = assignment(), data = catalog({items: [latest], deliveries: [delivery()]});
        const status = projectAgentStatus(data, pin, target), update = agentUpdate(latest, pin, status, true);
        expect(update).toEqual({catalogNewer: true, needsApply: false, attention: false}); expect(showAgentUpdate(update)).toBe(true);
        const noop = vi.fn(), html = renderToStaticMarkup(createElement(AgentCard, {agent: latest, assignment: pin, status, projectSelected: true,
            isMain: false, canManage: false, busy: false, unavailable: false, onView: noop, onEdit: noop, onArchived: noop, onAssign: noop,
            onConfigure: noop, onToggle: noop, onRemove: noop, onUpdate: noop}));
        expect(html).toContain('Каталог: шаблон v2'); expect(html).toContain('Проект: шаблон v1'); expect(html).toContain('Компьютер: подтверждён шаблон v1');
        expect(html).not.toContain('Установлено'); expect(noop).not.toHaveBeenCalled();
    });
    it('Старое подтверждение после обновления назначения требует применения, без выдуманной локальной v2', () => {
        const latest = agent({version: 2}), pin = assignment({version: 2, card: latest}), data = catalog({items: [latest], assignments: [pin], revision: 4, deliveries: [delivery()]});
        const status = projectAgentStatus(data, pin, target);
        expect(status.key).toBe('unapplied'); expect(agentUpdate(latest, pin, status, true)).toMatchObject({catalogNewer: false, needsApply: true});
    });
    it.each(['queued', 'running', 'reconciling', 'failed', 'cancelled', 'conflict'])('Фильтр сохраняет %s текущей папки при совпадении версий шаблона', state => {
        const data = catalog({deliveries: [delivery({state, result: null})]}), pin = assignment();
        expect(showAgentUpdate(agentUpdate(agent(), pin, projectAgentStatus(data, pin, target), true))).toBe(true);
    });
    it('Неподтверждённый каталог, старший pin, архив и удалённое назначение не создают новое предложение', () => {
        const status = projectAgentStatus(catalog({deliveries: [delivery()]}), assignment(), target);
        expect(agentUpdate(agent({version: 2}), assignment(), status, false).catalogNewer).toBe(false);
        expect(agentUpdate(agent(), assignment({version: 3}), status, true).catalogNewer).toBe(false);
        expect(agentUpdate(agent({version: 2, archivedAt: '2026-10-29'}), assignment(), status, true).catalogNewer).toBe(false);
        expect(agentUpdate(agent({version: 2}), assignment({removed: true}), status, true).catalogNewer).toBe(false);
    });
    it('Незавершённое удаление остаётся в фильтре до exact removal receipt', () => {
        const removed = assignment({removed: true}), data = catalog({assignments: [removed]});
        expect(showAgentUpdate(agentUpdate(agent(), removed, projectAgentStatus(data, removed, target), true))).toBe(true);
        data.deliveries = [delivery({result: {...delivery().result!, agents: []}})];
        expect(showAgentUpdate(agentUpdate(agent(), removed, projectAgentStatus(data, removed, target), true))).toBe(false);
    });
});
