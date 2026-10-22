import { describe, expect, it } from 'vitest';
import { agentTrialPending, agentTrialStatus, reconcileAgentTrial, requireAgentReadiness, requireAgentTrial } from '../src/features/AgentCatalog/readinessModel';
import { readiness, readinessItem, trial } from './agent-readiness.fixture';

describe('A trial is evidence about one server-chat model and exact configuration', () => {
    it('accepts complete metadata, preserves disabled-before-enable eligibility, and rejects foreign/incomplete receipts', () => {
        expect(requireAgentReadiness(readiness())).toEqual(readiness()); expect(requireAgentTrial(trial())).toEqual(trial());
        for (const bad of [null, {}, { ...trial(), executionSurface: 'opencode' }, { ...trial(), receipt: { ...trial().receipt, modelPin: null } },
            { ...trial(), receipt: { ...trial().receipt, checks: [{ kind: 'model_response', status: 'ready' }] } }]) expect(() => requireAgentTrial(bad)).toThrow('неполное');
        for (const bad of [{ executionSurface: 'native', items: [] }, readiness({ ...readinessItem(), currentPin: 'unknown' }),
            { ...readiness(), items: [readinessItem(), readinessItem()] }, readiness({ ...readinessItem(), eligibility: { ...readinessItem().eligibility, models: [{}] } })]) {
            expect(() => requireAgentReadiness(bad)).toThrow('не подтверждено');
        }
    });
    it('only completed required checks produce the precisely scoped success label', () => {
        expect(agentTrialStatus(trial())).toEqual({ label: 'Проверено в чате Нейроцентра', color: 'green' });
        const search = trial({ receipt: { ...trial().receipt, toolMode: 'project_search' } });
        expect(agentTrialStatus(search).color).toBe('red');
        search.receipt.checks.push({ kind: 'project_search', status: 'passed', message: 'Поиск выполнен.' });
        expect(agentTrialStatus(search).color).toBe('green');
        expect(agentTrialStatus(trial({ current: false, staleReason: 'Модель изменена' })).label).toContain('устарела');
        expect(agentTrialStatus(trial({ receipt: { ...trial().receipt, checks: [] } })).color).toBe('red');
        expect(agentTrialStatus().color).toBeUndefined();
    });
    it('duplicate, conflicting, incomplete or inconsistent receipts cannot claim success', () => {
        const base = trial(), failed = { kind: 'model_response' as const, status: 'failed' as const, message: 'Не подтверждено' };
        for (const bad of [trial({ receipt: { ...base.receipt, checks: [] } }), trial({ receipt: { ...base.receipt, checks: [...base.receipt.checks, failed] } }),
            trial({ receipt: { ...base.receipt, checks: [base.receipt.checks[0], failed] } }), trial({ finishedAt: null }), trial({ canCancel: true }),
            trial({ receipt: { ...base.receipt, toolMode: 'project_search' } })]) {
            expect(() => requireAgentTrial(bad)).toThrow('неполное'); expect(agentTrialStatus(bad).color).toBe('red');
        }
        expect(() => requireAgentTrial(trial({ status: 'running', finishedAt: base.finishedAt }))).toThrow('неполное');
        expect(() => requireAgentTrial(trial({ status: 'cancelled', canCancel: true }))).toThrow('неполное');
    });
    it('pending/cancelled/interrupted are explicit states and cannot become global ready', () => {
        for (const status of ['queued', 'running'] as const) { expect(agentTrialPending(trial({ status }))).toBe(true); expect(agentTrialStatus(trial({ status })).color).toBe('blue'); }
        expect(agentTrialStatus(trial({ status: 'cancelled' })).label).toContain('остановлено');
        expect(agentTrialStatus(trial({ status: 'interrupted' })).label).toContain('прервано');
        expect(agentTrialStatus(trial({ status: 'failed' })).label).toContain('не пройдено');
    });
    it('late trial acknowledgement cannot restore success for a changed agent or model pin', () => {
        const original = trial(); expect(reconcileAgentTrial(readinessItem(), original)).toBe(original);
        expect(reconcileAgentTrial(readinessItem({ currentPin: 'f'.repeat(64) }), original).current).toBe(false);
        expect(reconcileAgentTrial(readinessItem({ eligibility: { ...readinessItem().eligibility, models: [] } }), original).current).toBe(false);
        expect(reconcileAgentTrial(readinessItem(), trial({ current: false })).current).toBe(false);
    });
});
