// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCard } from '../AgentCard';
import type { IAgentCardProps } from '../interfaces';
import type { ICatalogAgent, IProjectAgent } from '../../interfaces';
import { FeatureAvailabilityContext } from '../../../FeatureFlags/FeatureAvailability';
import { featureDefinitions } from '../../../FeatureFlags/constants';
import { type IEvaluatedFeatureFlags, type TFeatureFlagKey } from '../../../FeatureFlags/interfaces';
import userBlockReducer from '../../../UserBlock/redux/reducers';

const agent: ICatalogAgent = {
    id: 'agent-one',
    slug: 'nc-helper',
    name: 'Помощник',
    description: 'Проверяет код',
    version: 2,
    manifest: 'a'.repeat(64),
    definition: { description: 'Проверяет код', prompt: 'Проверь код', mode: 'subagent', permission: {} },
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
};
const assignment: IProjectAgent = {
    agentId: agent.id,
    version: 1,
    manifest: 'b'.repeat(64),
    card: { ...agent, version: 1, name: 'Закреплённый помощник' },
    overrides: {},
    effective: { ...agent.definition, description: 'Инструкция проекта' },
    enabled: true,
    removed: false,
};

function availability(enabled: boolean): IEvaluatedFeatureFlags {
    const flags = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, enabled]),
    ) as IEvaluatedFeatureFlags['flags'];
    const blockedBy = Object.fromEntries(
        featureDefinitions.map(({ key }) => [key, [] as TFeatureFlagKey[]]),
    ) as IEvaluatedFeatureFlags['blockedBy'];
    return { flags, configured: flags, blockedBy };
}

function props(overrides: Partial<IAgentCardProps> = {}): IAgentCardProps {
    return {
        agent,
        isMain: false,
        canManage: true,
        projectSelected: true,
        busy: false,
        unavailable: false,
        onView: vi.fn(),
        onEdit: vi.fn(),
        onArchived: vi.fn(),
        onAssign: vi.fn(),
        onConfigure: vi.fn(),
        onToggle: vi.fn(),
        onRemove: vi.fn(),
        onUpdate: vi.fn(),
        ...overrides,
    };
}

describe('AgentCard actions', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });

    async function render(input: IAgentCardProps, enabled = true): Promise<void> {
        const store = configureStore({ reducer: { userBlock: userBlockReducer } });
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <FeatureAvailabilityContext.Provider
                        value={{
                            data: availability(enabled),
                            loading: false,
                            error: null,
                            refresh: async () => undefined,
                        }}
                    >
                        <AgentCard {...input} />
                    </FeatureAvailabilityContext.Provider>
                </Provider>,
            );
        });
    }
    function button(label: string): HTMLButtonElement | undefined {
        return [...container.querySelectorAll('button')].find(
            (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label,
        );
    }
    async function click(label: string): Promise<void> {
        const target = button(label);
        expect(target, label).toBeDefined();
        await act(async () => target!.click());
    }

    it('lets a manager add an agent and keeps preview available', async () => {
        const input = props();
        await render(input);
        await click('Добавить в проект');
        await click('Промпт агента Помощник');
        expect(input.onAssign).toHaveBeenCalledTimes(1);
        expect(input.onView).toHaveBeenCalledTimes(1);
    });

    it('does not expose mutation controls without project management rights', async () => {
        await render(props({ canManage: false }));
        expect(button('Добавить в проект')).toBeUndefined();
        expect(button('Изменить агента Помощник')).toBeUndefined();
        expect(container.textContent).toContain('Добавляет администратор проекта');
        expect(button('Промпт агента Помощник')?.disabled).toBe(false);
    });

    it('preserves the pinned version and invokes project callbacks independently', async () => {
        const input = props({ assignment, onTrial: vi.fn() });
        await render(input);
        expect(container.textContent).toContain('Закреплённый помощник');
        expect(container.textContent).toContain('Инструкция проекта');
        expect(container.textContent).toContain('Проект сохраняет v1');
        await click('Настроить');
        await click('Отключить');
        await click('Удалить из проекта агента Закреплённый помощник');
        await click('Обновить шаблон');
        await click('Испытать в чате');
        for (const callback of [input.onConfigure, input.onToggle, input.onRemove, input.onUpdate, input.onTrial]) {
            expect(callback).toHaveBeenCalledTimes(1);
        }
    });

    it('keeps disable and removal available when the agents feature is switched off', async () => {
        const input = props({ assignment });
        await render(input, false);
        expect(button('Настроить')?.disabled).toBe(true);
        expect(button('Обновить шаблон')?.disabled).toBe(true);
        expect(button('Отключить')?.disabled).toBe(false);
        await click('Отключить');
        await click('Удалить из проекта агента Закреплённый помощник');
        expect(input.onToggle).toHaveBeenCalledTimes(1);
        expect(input.onRemove).toHaveBeenCalledTimes(1);
    });

    it.each(['busy', 'unavailable'] as const)('blocks writes during %s while retaining preview', async (condition) => {
        const input = props({ assignment, [condition]: true });
        await render(input);
        for (const label of [
            'Настроить',
            'Отключить',
            'Обновить шаблон',
            'Удалить из проекта агента Закреплённый помощник',
        ]) {
            expect(button(label)?.disabled, label).toBe(true);
            await click(label);
        }
        expect(input.onConfigure).not.toHaveBeenCalled();
        expect(input.onToggle).not.toHaveBeenCalled();
        expect(input.onUpdate).not.toHaveBeenCalled();
        expect(input.onRemove).not.toHaveBeenCalled();
        await click('Промпт агента Закреплённый помощник');
        expect(input.onView).toHaveBeenCalledTimes(1);
    });

    it('disables editing and new assignment of an archived template', async () => {
        const input = props({ isMain: true, agent: { ...agent, archivedAt: '2026-11-01T01:00:00Z' } });
        await render(input);
        expect(button('Изменить агента Помощник')?.disabled).toBe(true);
        expect(button('Добавить в проект')?.disabled).toBe(true);
        expect(button('Вернуть в каталог агента Помощник')).toBeDefined();
        await click('Изменить агента Помощник');
        await click('Добавить в проект');
        expect(input.onEdit).not.toHaveBeenCalled();
        expect(input.onAssign).not.toHaveBeenCalled();
    });
});
