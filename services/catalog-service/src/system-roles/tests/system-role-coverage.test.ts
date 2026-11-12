import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLE_COVERAGE } from '../system-role.coverage';
import {
    ROLE_BUDGET,
    SYSTEM_ROLE_DEFINITIONS,
    roleCallBudget,
    roleDefinitionPin,
    systemRole,
} from '../system-role.definitions';
import { previousRoleDefinitionPin } from '../system-role.previous-contract';
import { SYSTEM_ROLE_MCP_LIMITS } from '../../../../shared/system-role-mcp.cjs';

/** FR-303: the required question classes of the system (ticket Intent list). */
const REQUIRED_CLASSES = [
    'configuration-computer',
    'diagnostics',
    'models',
    'bridges',
    'skills-plugins-mcp',
    'agents-assets',
    'access',
    'data-rag-quirk',
    'queues',
    'updates',
    'recovery',
];

describe('FR-303 coverage matrix', () => {
    it('covers every required system-question class (no «никто не отвечает»)', () => {
        const covered = new Set(SYSTEM_ROLE_COVERAGE.map((entry) => entry.cls));
        for (const cls of REQUIRED_CLASSES) expect(covered.has(cls), `класс «${cls}» вне матрицы`).toBe(true);
    });

    it('every owner exists in the role definitions with at least one owner per class', () => {
        for (const entry of SYSTEM_ROLE_COVERAGE) {
            expect(entry.owners.length, `класс «${entry.cls}» без владельца`).toBeGreaterThan(0);
            const seen = new Set<string>();
            for (const owner of entry.owners) {
                const definition = SYSTEM_ROLE_DEFINITIONS.find((role) => role.id === owner.role);
                expect(
                    definition,
                    `владелец ${owner.role} (класс «${entry.cls}») не найден в определениях`,
                ).toBeTruthy();
                expect(seen.has(owner.role), `дубликат владельца ${owner.role} в классе «${entry.cls}»`).toBe(false);
                seen.add(owner.role);
            }
        }
    });

    it('every ownership is structurally grounded in a real role capability (target or diagnostic)', () => {
        for (const entry of SYSTEM_ROLE_COVERAGE) {
            for (const owner of entry.owners) {
                const definition = systemRole(owner.role);
                const grounded =
                    (owner.target !== undefined && definition.targets.includes(owner.target)) ||
                    (owner.diagnostic !== undefined && definition.diagnostics.includes(owner.diagnostic));
                expect(
                    grounded,
                    `обоснование ${owner.role} в классе «${entry.cls}»: target=${owner.target ?? '—'} ` +
                        `diagnostic=${owner.diagnostic ?? '—'} не совпадает с возможностями роли`,
                ).toBe(true);
            }
        }
    });
});

describe('FR-303 coordinator owner of the next action', () => {
    it('the coordinator guidance names the owner (system role/project agent/human) in every next step', () => {
        const prompt = systemRole('agent-coordinator').prompt;
        expect(prompt).toContain('Для каждого пункта nextSteps укажи владельца следующего действия');
        expect(prompt).toContain('системная роль (точный ID), агент проекта или человек');
    });

    it('the owner requirement is coordinator-specific (other roles keep their own contracts)', () => {
        for (const role of SYSTEM_ROLE_DEFINITIONS) {
            if (role.id === 'agent-coordinator') continue;
            expect(role.prompt, role.id).not.toContain('владельца следующего действия');
        }
    });

    it('the guidance change moves the coordinator pin away from the accepted previous contract', () => {
        const pin = roleDefinitionPin('agent-coordinator');
        expect(pin).toMatch(/^[a-f0-9]{64}$/);
        expect(pin).not.toBe(previousRoleDefinitionPin('agent-coordinator'));
    });
});

describe('FR-303 call budget (fail-closed, NFR-6)', () => {
    it('keeps the frozen budget constants: coordinatorCalls=5, calls=2, fanout=3, depth=1', () => {
        expect(ROLE_BUDGET.coordinatorCalls).toBe(5);
        expect(ROLE_BUDGET.calls).toBe(2);
        expect(ROLE_BUDGET.fanout).toBe(3);
        expect(ROLE_BUDGET.depth).toBe(1);
    });

    it('exposes the fail-closed per-role budget: coordinator 5 (+mcp), other roles 2', () => {
        expect(roleCallBudget('agent-coordinator')).toBe(ROLE_BUDGET.coordinatorCalls);
        expect(roleCallBudget('agent-coordinator', true)).toBe(
            ROLE_BUDGET.coordinatorCalls + SYSTEM_ROLE_MCP_LIMITS.calls,
        );
        for (const role of SYSTEM_ROLE_DEFINITIONS) {
            if (role.id === 'agent-coordinator') continue;
            expect(roleCallBudget(role.id), role.id).toBe(ROLE_BUDGET.calls);
        }
    });
});
