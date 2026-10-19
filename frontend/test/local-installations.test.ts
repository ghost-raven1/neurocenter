import { describe, expect, it } from 'vitest';
import {
    currentInstallation,
    isPending,
    latestAssetJob,
} from '../src/features/McpBridge/installationHelpers';
import type {
    IBridgeInstallation,
    IBridgeJob,
} from '../src/features/McpBridge/api';

const target = {
    deviceId: 'мой компьютер',
    projectId: 'мой проект',
    assetId: 'инструмент',
    assetKind: 'skill',
};
const installation: IBridgeInstallation = {
    ...target,
    assetKind: 'skill',
    manifest: 'a'.repeat(64),
    name: 'Помощник',
    version: 1,
    updatedAt: '2026-10-16T00:00:00Z',
};
const job: IBridgeJob = {
    ...target,
    id: 'job',
    kind: 'install',
    state: 'succeeded',
    message: 'Установлен',
    version: '1',
    createdAt: installation.updatedAt,
    updatedAt: installation.updatedAt,
};
describe('Установки на выбранном компьютере', () => {
    it('Не скрывает старую операцию сверки за более новой записью истории', () => {
        const pending = { ...job, id: 'uncertain', state: 'reconciling' };
        expect(latestAssetJob([job, pending], target)?.id).toBe('uncertain');
        expect(isPending(pending)).toBe(true);
    });
    it('История прежней папки не показывает инструмент установленным в новой привязке', () => {
        expect(currentInstallation([{ ...installation, bindingChanged: true }], target)).toBeUndefined();
    });
    it('Удаление новее установки не выдаётся за успешную установку', () => {
        expect(
            latestAssetJob(
                [{ ...job, id: 'remove', kind: 'uninstall' }, job],
                target,
            )?.kind,
        ).toBe('uninstall');
    });
    it('Задание другой версии тоже блокирует параллельное изменение инструмента', () => {
        expect(
            isPending(
                latestAssetJob(
                    [{ ...job, state: 'running', version: '2' }],
                    target,
                ),
            ),
        ).toBe(true);
    });
    it.each([
        { deviceId: 'другой компьютер' },
        { projectId: 'другой проект' },
        { assetKind: 'mcp' },
        { assetId: 'другой инструмент' },
    ])('Не смешивает установки разных назначений: %j', (change) => {
        expect(
            currentInstallation(
                [{ ...installation, ...change } as IBridgeInstallation],
                target,
            ),
        ).toBeUndefined();
        expect(latestAssetJob([{ ...job, ...change }], target)).toBeUndefined();
    });
    it('До выбора компьютера и проекта не показывает чужое задание', () => {
        expect(
            latestAssetJob([job], { ...target, deviceId: undefined }),
        ).toBeUndefined();
        expect(
            currentInstallation([installation], {
                ...target,
                projectId: undefined,
            }),
        ).toBeUndefined();
    });
    it('Не принимает синхронизацию за установку и разрешает повтор после ошибки', () => {
        expect(
            latestAssetJob([{ ...job, kind: 'sync-rag' }], target),
        ).toBeUndefined();
        expect(isPending({ ...job, state: 'failed' })).toBe(false);
        expect(currentInstallation([installation], target)).toEqual(
            installation,
        );
    });
});
