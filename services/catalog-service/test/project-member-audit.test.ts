import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { ProjectMemberRepository } from '../src/catalog/project-member-repository';

const member = { userId: 'u-member@example.invalid', principalName: 'member@example.invalid', displayName: 'Участник', role: 'Наблюдатель', addedAt: '2026-10-18T10:00:00Z' };
const row = { user_id: member.userId, principal_name: member.principalName, display_name: member.displayName, role: member.role, added_at: member.addedAt };
const actor = {email:'admin@example.invalid',activeRole:'Главный админ'};
type Query=(sql:string,params?:unknown[])=>Promise<{rows:unknown[]}>;

describe('Атомарный аудит проектных назначений', () => {
    let query: ReturnType<typeof vi.fn<Query>>;
    let release: ReturnType<typeof vi.fn>;
    let repository: ProjectMemberRepository;

    beforeEach(() => {
        query = vi.fn<Query>(async (sql: string, params?: unknown[]) => {
            if(sql.startsWith('SELECT enabled,is_main_admin FROM platform_users'))return{rows:[{enabled:true,is_main_admin:true}]};
            if (sql.startsWith('SELECT * FROM project_members') || sql.startsWith('INSERT INTO project_members')) { return { rows: [row] }; }
            if (sql.startsWith('UPDATE project_members')) { return { rows: [{ ...row, role: params![2] }] }; }
            return { rows: [] };
        });
        release = vi.fn();
        repository = new ProjectMemberRepository({ connect: async () => ({ query, release }) } as unknown as Pool);
    });

    const events = (query: ReturnType<typeof vi.fn<Query>>) => query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'));

    it('Выдача сохраняет исполнителя и адрес сотрудника до COMMIT', async () => {
        expect(await repository.add('prj-qa', member, actor)).toEqual(member);
        const event = events(query)[0][1] as unknown[];
        expect(event.slice(1, 4)).toEqual([actor.email, 'project.member.add', 'prj-qa · member@example.invalid']);
        expect(JSON.parse(String(event[4]))).toBeNull();
        expect(JSON.parse(String(event[5]))).toEqual({ projectId: 'prj-qa', ...member });
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Смена роли фиксирует исходное назначение под блокировкой строки', async () => {
        await repository.update('prj-qa', member.userId, 'Разработчик', 'Наблюдатель', actor);
        expect(query.mock.calls.find(([sql])=>sql.startsWith('SELECT * FROM project_members'))?.[0]).toContain('FOR UPDATE');
        const event = events(query)[0][1] as unknown[];
        expect(event[2]).toBe('project.member.update');
        expect(JSON.parse(String(event[4])).role).toBe('Наблюдатель');
        expect(JSON.parse(String(event[5])).role).toBe('Разработчик');
    });

    it('Отзыв фиксирует удалённое назначение и не выдумывает новое', async () => {
        expect(await repository.remove('prj-qa', member.userId, 'Наблюдатель', actor)).toBe(true);
        const event = events(query)[0][1] as unknown[];
        expect(event[2]).toBe('project.member.remove');
        expect(JSON.parse(String(event[4]))).toMatchObject({ projectId: 'prj-qa', principalName: member.principalName });
        expect(JSON.parse(String(event[5]))).toBeNull();
    });

    it.each(['add', 'update', 'remove'] as const)('Ошибка аудита откатывает %s вместе с изменением', async method => {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, params?: unknown[]) => {
            if (sql.startsWith('INSERT INTO security_events')) { throw new Error('Журнал недоступен'); }
            return original(sql, params);
        });
        const change = method === 'add' ? repository.add('prj-qa', member, actor)
            : method === 'update' ? repository.update('prj-qa', member.userId, 'Разработчик', 'Наблюдатель', actor)
                : repository.remove('prj-qa', member.userId, 'Наблюдатель', actor);
        await expect(change).rejects.toThrow('Журнал недоступен');
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
        expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
        expect(release).toHaveBeenCalledOnce();
    });

    it('Конфликт исходной роли не изменяет назначение и не пишет успешный аудит', async () => {
        expect(await repository.update('prj-qa', member.userId, 'Разработчик', 'Админ проекта', actor)).toBeNull();
        expect(await repository.remove('prj-qa', member.userId, 'Админ проекта', actor)).toBe(false);
        expect(events(query)).toEqual([]);
        expect(query.mock.calls.some(([sql]) => /^(UPDATE|DELETE) /.test(sql))).toBe(false);
    });

    it('Повтор без изменения роли не создаёт ложное событие', async () => {
        expect(await repository.update('prj-qa', member.userId, member.role, member.role, actor)).toEqual(member);
        expect(events(query)).toEqual([]);
        expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE '))).toBe(false);
    });

    it('Конкурирующее добавление не возвращает ложный успех', async () => {
        query.mockImplementation(async (sql:string) => ({ rows: sql.startsWith('SELECT enabled,is_main_admin FROM platform_users')?[{enabled:true,is_main_admin:true}]:[] }));
        await expect(repository.add('prj-qa', member, actor)).rejects.toThrow('Сотрудник уже в проекте');
        expect(events(query)).toEqual([]);
        expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    });

    it('Неизвестная роль не создаёт назначение или успешный аудит',async()=>{
        await expect(repository.add('prj-qa',{...member,role:'Главный админ'},actor)).rejects.toMatchObject({status:400});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO project_members'))).toBe(false);expect(events(query)).toEqual([]);
    });
});
