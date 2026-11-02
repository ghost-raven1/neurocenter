import { describe, expect, it } from 'vitest';
import type { ICatalogModel } from '../../ModelCatalog/interfaces';
import { chatModelSetupActions, chatModelSetupVisible } from '../chatModelSetup';

const model = (patch: Partial<ICatalogModel> = {}): ICatalogModel => ({
    id: 'm1',
    name: 'Model',
    description: '',
    capability: 'chat',
    runtime: 'remote-openai',
    model: 'model',
    manifestSha256: null,
    verificationSha256: null,
    dimension: null,
    source: 'custom',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...patch,
});

describe('chatModelSetupActions', () => {
    it('keeps a ready model untouched', () => {
        expect(chatModelSetupActions(model({ verificationSha256: 'a'.repeat(64) }), true, true, true)).toEqual({
            reason: '',
            actions: [],
            hint: '',
        });
        expect(
            chatModelSetupActions(model({ runtime: 'ollama', manifestSha256: 'b'.repeat(64) }), true, true, true),
        ).toEqual({ reason: '', actions: [], hint: '' });
        // device-codex readiness does not depend on the server-side verification.
        expect(chatModelSetupActions(model({ runtime: 'device-codex' }), true, true, true)).toEqual({
            reason: '',
            actions: [],
            hint: '',
        });
    });

    it('asks for the project assignment first', () => {
        expect(chatModelSetupActions(model({ verificationSha256: 'a'.repeat(64) }), false, true, true)).toEqual({
            reason: 'Сначала добавьте модель в выбранный проект.',
            actions: ['assign'],
            hint: '',
        });
    });

    it('does not offer the assignment to a role that cannot assign, with an explanation', () => {
        expect(chatModelSetupActions(model({ verificationSha256: 'a'.repeat(64) }), false, false, true)).toEqual({
            reason: 'Сначала добавьте модель в выбранный проект.',
            actions: [],
            hint: 'Добавить модель в проект может администратор проекта.',
        });
    });

    it('completes a remote model with the provider, the key, and the connection check', () => {
        for (const runtime of ['remote-openai', 'remote-ollama'] as const)
            expect(chatModelSetupActions(model({ runtime }), true, true, true)).toEqual({
                reason: 'Сначала настройте API и проверьте подключение модели.',
                actions: ['provider', 'check'],
                hint: '',
            });
    });

    it('keeps the key step for a role that cannot verify, with an explanation', () => {
        expect(chatModelSetupActions(model(), true, true, false)).toEqual({
            reason: 'Сначала настройте API и проверьте подключение модели.',
            actions: ['provider'],
            hint: 'Проверку подключения после сохранения выполняет главный администратор.',
        });
    });

    it('asks for a server check before an ollama model is verified', () => {
        expect(chatModelSetupActions(model({ runtime: 'ollama' }), true, true, true)).toEqual({
            reason: 'Сначала запустите или проверьте модель на сервере.',
            actions: ['check'],
            hint: '',
        });
        expect(chatModelSetupActions(model({ runtime: 'ollama' }), true, true, false)).toEqual({
            reason: 'Сначала запустите или проверьте модель на сервере.',
            actions: [],
            hint: 'Проверить модель на сервере может главный администратор.',
        });
    });

    it('never offers actions for an embedding model', () => {
        for (const assigned of [true, false]) {
            const value = chatModelSetupActions(model({ capability: 'embedding' }), assigned, true, true);
            expect(value.reason).not.toBe('');
            expect(value.actions).toEqual([]);
        }
    });
});

describe('chatModelSetupVisible', () => {
    const base = { flagEnabled: true, canUse: true, loading: false, error: false, readyCount: 0 };
    it('shows the panel only when every gate passes', () => {
        expect(chatModelSetupVisible(base)).toBe(true);
    });
    it('hides the panel when the flag is off', () => {
        expect(chatModelSetupVisible({ ...base, flagEnabled: false })).toBe(false);
    });
    it('hides the panel without a working role in the project', () => {
        expect(chatModelSetupVisible({ ...base, canUse: false })).toBe(false);
    });
    it('hides the panel while the catalog is loading or failed', () => {
        expect(chatModelSetupVisible({ ...base, loading: true })).toBe(false);
        expect(chatModelSetupVisible({ ...base, error: true })).toBe(false);
    });
    it('hides the panel as soon as one model is ready', () => {
        expect(chatModelSetupVisible({ ...base, readyCount: 1 })).toBe(false);
    });
});
