import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardWorkspaceQueue } from '../src/devices/workspace-queue';

describe('Смена папки и ожидающие задания', () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;
    const input = { deviceId: 'computer', projectId: 'project', email: 'owner@example.test', kind: 'bind-project' };
    beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });
    it.each(['running', 'reconciling'])('Начатое действие %s не прерывается сменой папки', async state => {
        query.mockResolvedValue({ rows: [{ id: 'active', state }] });
        await expect(guardWorkspaceQueue(client, input)).rejects.toMatchObject({ status: 409 });
        expect(query).toHaveBeenCalledOnce();
    });
    it('Отменяет старую очередь проекта до смены привязки и сохраняет операции', async () => {
        query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('UPDATE')
            ? [{ id: 'old', kind: 'install', email: input.email, project_id: 'project' }] : [] }));
        await guardWorkspaceQueue(client, input);
        expect(query.mock.calls[1][1]).toEqual(['computer', 'project']);
        expect(query.mock.calls[1][0]).toContain("state='queued'");
        expect(query.mock.calls[2][0]).toContain('INSERT INTO operations');
    });
    it('Выбор общей папки учитывает задания всех проектов этого компьютера', async () => {
        await guardWorkspaceQueue(client, { ...input, kind: 'choose-root' });
        expect(query.mock.calls[0][1]).toEqual(['computer', null]);
        expect(query.mock.calls[1][1]).toEqual(['computer', null]);
    });
    it('Обычная установка не отменяет очередь и не меняет папку', async () => {
        await guardWorkspaceQueue(client, { ...input, kind: 'install' });
        expect(query).not.toHaveBeenCalled();
    });
});
