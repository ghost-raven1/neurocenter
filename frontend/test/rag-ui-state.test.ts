import { describe, expect, it } from 'vitest';
import { latestRagUiJob, ragUiBlocker, ragUiInstallations, ragUiJobMatches, ragUiOutcome, ragUiRequest } from '../src/features/McpBridge/ragUi/ragUiState';
import { ragUiFixture } from './ragUiFixture';

describe('Готовность локального интерфейса OpenCodeRAG', () => {
    const ready = () => {
        const f = ragUiFixture();
        return { ...f.bridge, projectId: f.binding.projectId, binding: f.binding, installation: f.item, canWrite: true };
    };
    it('Поддержка определяется закреплённой установкой текущей папки, название не выдаёт права', () => {
        const { item, device, binding } = ragUiFixture();
        const candidates = [item, { ...item, assetId: 'name-only', ragUi: undefined }, { ...item, assetId: 'old-folder', bindingId: 'c'.repeat(64) },
            { ...item, assetId: 'old-version', isCurrentBinding: false }, { ...item, assetId: 'other-device', deviceId: 'other' }, { ...item, assetId: 'legacy', legacyBinding: true }];
        expect(ragUiInstallations(candidates, device, binding.projectId, binding.bindingId).map(row => row.assetId)).toEqual([item.assetId]);
    });
    it('Разрешает пустой индекс без требования прошедшего runtime probe', () => {
        const state = ready(); expect(state.installation.runtime).toBeUndefined(); expect(ragUiBlocker(state)).toBe('');
    });
    it.each([
        [{ canWrite: false }, 'разработчик'], [{ devicesReady: false }, 'проверки подключения'], [{ device: undefined }, 'Выберите подключённый компьютер'],
        [{ binding: undefined }, 'подтвердите папку'], [{ jobsReady: false }, 'загрузки установок'], [{ installationsReady: false }, 'загрузки установок'],
        [{ installation: undefined }, 'Установите или обновите'], [{ installation: undefined, choiceCount: 2 }, 'Выберите установленный пакет'],
    ])('Даёт причину недоступности %#', (change, reason) => { expect(ragUiBlocker({ ...ready(), ...change })).toContain(reason); });
    it('Офлайн, истёкшая сессия и старый мост требуют конкретного следующего шага', () => {
        const state = ready();
        expect(ragUiBlocker({ ...state, device: { ...state.device!, online: false } })).toContain('Включите выбранный компьютер');
        expect(ragUiBlocker({ ...state, device: { ...state.device!, requiresReconnect: true } })).toContain('Подтвердите его заново');
        expect(ragUiBlocker({ ...state, device: { ...state.device!, report: { ...state.device!.report, capabilities: ['durable-completions', 'managed-installations'] } } })).toContain('0.9.5');
        expect(ragUiBlocker({ ...state, binding: { ...state.binding, instanceId: undefined } })).toContain('подтвердите папку');
    });
    it('Изменение и синхронизация текущей папки блокируют открытие, чужая история не мешает', () => {
        const state = ready(), f = ragUiFixture();
        for (const kind of ['install', 'uninstall', 'sync-rag', 'restore-rag', 'bind-project', 'open-rag-ui']) {
            expect(ragUiBlocker({ ...state, jobs: [f.job({ kind, state: 'running' })] })).toContain('Дождитесь завершения');
        }
        expect(ragUiBlocker({ ...state, jobs: [f.job({ deviceId: 'other' }), f.job({ projectId: 'other' }), f.job({ bindingId: 'old' })] })).toBe('');
    });
    it('POST содержит точный комплект и экземпляр без локального пути или адреса', () => {
        const { item, binding } = ragUiFixture(); const request = ragUiRequest(item, binding);
        expect(request).toMatchObject({ kind: 'open-rag-ui', deviceId: item.deviceId, projectId: item.projectId, assetId: item.assetId, assetKind: 'mcp',
            version: 3, expectedManifest: item.manifest, expectedBindingId: binding.bindingId, expectedInstanceId: binding.instanceId });
        expect(JSON.stringify(request)).not.toContain('folderName'); expect(JSON.stringify(request)).not.toContain('http');
        expect(() => ragUiRequest(item, { ...binding, bindingId: 'd'.repeat(64) })).toThrow('изменилась');
    });
});

describe('Результат открытия относится к выбранной установке', () => {
    it('Не принимает старые компьютер, папку, версию, SHA и instance', () => {
        const { item, binding, job } = ragUiFixture();
        expect(ragUiJobMatches(job(), item, binding.instanceId)).toBe(true);
        for (const change of [{ deviceId: 'other' }, { projectId: 'other' }, { bindingId: 'old' }, { assetId: 'other' }, { version: '2' },
            { expectedManifest: 'c'.repeat(64) }, { expectedInstanceId: 'other' }]) {
            expect(ragUiJobMatches(job(change), item, binding.instanceId)).toBe(false);
        }
    });
    it('Подтверждённый ответ POST показывается до обновления списка, pending имеет приоритет', () => {
        const { item, binding, job } = ragUiFixture();
        const submitted = job({ state: 'succeeded', updatedAt: '2026-10-19T02:00:00Z' });
        expect(latestRagUiJob([job()], item, binding.instanceId, submitted)?.state).toBe('succeeded');
        expect(latestRagUiJob([submitted], item, binding.instanceId, job({ updatedAt: submitted.updatedAt }))?.state).toBe('succeeded');
        expect(latestRagUiJob([submitted, job({ id: 'pending', createdAt: '2026-10-19T03:00:00Z' })], item, binding.instanceId)?.id).toBe('pending');
    });
    it('Один succeeded без подтверждения opened не объявляется открытым окном', () => {
        const { job } = ragUiFixture();
        expect(ragUiOutcome(job({ state: 'succeeded', result: { ok: true } }))).toBeUndefined();
        expect(ragUiOutcome(job({ state: 'succeeded', result: { opened: true, reused: false, note: '' } }))).toBeUndefined();
        expect(ragUiOutcome(job({ state: 'succeeded', result: { opened: true, reused: false, note: 'Окно открыто', url: 'private' } }))).toBeUndefined();
        expect(ragUiOutcome(job({ state: 'succeeded', result: { opened: true, reused: true, note: 'Окно уже открыто' } }))).toEqual({ opened: true, reused: true, note: 'Окно уже открыто' });
    });
});
