import { describe, expect, it, vi } from 'vitest';
import { createAvailabilityController, emptyAvailability } from '../src/features/FeatureFlags/availabilityController';
import { featureAvailability } from '../src/features/FeatureFlags/FeatureAvailability';
import { configuredBlockers, featureDefinitions, featureFlagKeys, requireEvaluatedFeatureFlags } from '../src/features/FeatureFlags/types';
import type { IEvaluatedFeatureFlags } from '../src/features/FeatureFlags/types';

const evaluated = (): IEvaluatedFeatureFlags => ({ flags: Object.fromEntries(featureFlagKeys.map(key => [key, true])),
    configured: Object.fromEntries(featureFlagKeys.map(key => [key, true])), blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []])) }) as IEvaluatedFeatureFlags;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('Единая доступность функций', () => {
    it('Проверяет все 43 ключа общего реестра; старые три ключа и повреждённые зависимости не разрешают работу', () => {
        expect(featureFlagKeys).toHaveLength(43); expect(new Set(featureFlagKeys).size).toBe(43);
        expect(featureDefinitions.find(item => item.key === 'opencode_providers')).toMatchObject({ defaultEnabled: false, dependsOn: ['computer_connections', 'model_catalog'] });
        expect(featureDefinitions.find(item => item.key === 'codex_connector')).toMatchObject({ defaultEnabled: false, dependsOn: ['opencode_providers'] });
        expect(featureDefinitions.find(item => item.key === 'project_chat')).toMatchObject({defaultEnabled: true, dependsOn: []});
        expect(featureDefinitions.find(item => item.key === 'project_chat_dialogs')).toMatchObject({defaultEnabled: true, dependsOn: ['project_chat']});
        expect(featureDefinitions.find(item => item.key === 'chat_activity')).toMatchObject({defaultEnabled: true, dependsOn: []});
        expect(featureDefinitions.find(item => item.key === 'model_rate_limits')).toMatchObject({defaultEnabled: true, dependsOn: []});
        expect(requireEvaluatedFeatureFlags(evaluated())).toEqual(evaluated());
        for (const key of featureFlagKeys) {
            for (const field of ['flags', 'configured', 'blockedBy'] as const) {
                const data = evaluated(), incomplete = { ...data, [field]: Object.fromEntries(Object.entries(data[field]).filter(([item]) => item !== key)) };
                expect(() => requireEvaluatedFeatureFlags(incomplete)).toThrow('полный список');
            }
        }
        expect(() => requireEvaluatedFeatureFlags({ flags: { model_hosting: true, tool_builds: true, rag_sync: true } })).toThrow('полный список');
        const broken = evaluated(); broken.blockedBy.group_chat = ['unknown' as never]; expect(() => requireEvaluatedFeatureFlags(broken)).toThrow('полный список');
        const conflict = evaluated(); conflict.configured.model_chat = false; expect(() => requireEvaluatedFeatureFlags(conflict)).toThrow('полный список');
    });
    it('Неизвестное состояние закрывает новые действия, но пустой набор требований сохраняет recovery', () => {
        expect(featureAvailability(emptyAvailability(), ['agents'])).toMatchObject({ enabled: false, reason: 'Проверяем доступность функций…' });
        expect(featureAvailability({ ...emptyAvailability(), error: 'Offline' }, ['agents']).reason).toContain('не подтверждена');
        expect(featureAvailability(emptyAvailability(), []).enabled).toBe(true);
    });
    it('Показывает причину зависимости, сохраняя собственный переключатель включённым', () => {
        const data = evaluated(); data.flags.group_chat = false; data.configured.agents = false; data.blockedBy.group_chat = ['agents'];
        expect(featureAvailability({ data, loading: false, error: null }, ['group_chat'])).toMatchObject({ enabled: false });
        expect(featureAvailability({ data, loading: false, error: null }, ['group_chat']).reason).toContain('Управление агентами');
        const items = featureDefinitions.map(item => ({ ...item, enabled: item.key !== 'model_hosting', revision: 1, updatedAt: null, updatedBy: null }));
        expect(configuredBlockers('group_chat', items)).toEqual(['model_hosting']);
        expect(configuredBlockers('chat_activity', items)).toEqual([]);
        expect(items.find(item => item.key === 'group_chat')?.enabled).toBe(true);
        const withoutModels = items.map(item => ({ ...item, enabled: item.key !== 'model_catalog' }));
        expect(configuredBlockers('opencode_providers', withoutModels)).toEqual(['model_catalog']);
        expect(configuredBlockers('codex_connector', withoutModels)).toEqual(['model_catalog']);
    });
    it('Ошибка обновления снимает прежнее разрешение; восстановление требует нового полного ответа', async () => {
        let state = emptyAvailability(); const read = vi.fn(async (): Promise<unknown> => evaluated());
        const controller = createAvailabilityController({ read, captureOwner: () => () => true, onChange: value => { state = value; } }); controller.activate();
        await controller.refresh(); expect(state.data?.flags.model_chat).toBe(true);
        read.mockRejectedValueOnce(new Error('Offline')); await controller.refresh(); expect(state.data).toBeNull(); expect(state.error).toBe('Offline');
        await controller.refresh(); expect(state.data?.flags.model_chat).toBe(true); expect(state.error).toBeNull();
    });
    it('Поздние ответы старой роли и предыдущего refresh не возвращают разрешения', async () => {
        let owner = true, state = emptyAvailability(); const first = deferred<unknown>(), second = deferred<unknown>();
        const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const controller = createAvailabilityController({ read, captureOwner: () => () => owner, onChange: value => { state = value; } }); controller.activate();
        const before = controller.refresh(), latest = controller.refresh(); const data = evaluated(); data.flags.model_chat = false; data.configured.model_chat = false;
        second.resolve(data); await latest; first.resolve(evaluated()); await before; expect(state.data?.flags.model_chat).toBe(false);
        const late = deferred<unknown>(); read.mockReturnValueOnce(late.promise); const pending = controller.refresh(); owner = false; late.resolve(evaluated()); await pending; expect(state.data?.flags.model_chat).toBe(false);
        controller.dispose(); controller.activate(); expect(state.data).toBeNull();
    });
});
