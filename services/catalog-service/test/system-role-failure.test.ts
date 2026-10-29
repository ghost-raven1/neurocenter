import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SystemRoleService } from '../src/system-roles/system-role.service';
import { SystemRoleStepTimeout } from '../src/system-roles/system-role.runner';
import { withRoleMcpTools } from '../src/system-role-mcp/system-role-mcp.loop';
import { normalizeRoleMcpTool, roleMcpToolKey } from '../../shared/system-role-mcp.cjs';
import type { RoleRunRow } from '../src/system-roles/system-role.types';

vi.mock('../src/system-roles/system-role.operations', () => ({ notifyRoleOperations: vi.fn(), projectRoleOperation: vi.fn() }));

/** Exercise actual failure persistence with an isolated repository and no model transport. */
function fixture(overrides: Partial<RoleRunRow> = {}) {
    const infer = vi.fn(), service = new SystemRoleService({ pool: {} } as never, {} as never, {} as never, {} as never, { infer } as never, {} as never);
    const row = { id: 'run', state: 'running', phase: 'collecting', calls_started: 0, lease_token: 'lease', facts: [{ id: 'saved' }], result: null, steps: [], revision: 4, ...overrides } as RoleRunRow;
    const db = {} as never;
    vi.spyOn(service.repository, 'transaction').mockImplementation(async work => work(db));
    const get = vi.spyOn(service.repository, 'get').mockResolvedValue(row);
    const change = vi.spyOn(service.repository, 'change').mockImplementation(async (_db, current, state, phase, message) => {
        Object.assign(current, { state, phase, message }); return current;
    });
    const fail = (cause?: unknown, interrupted = false, claimed = { ...row }) => (service as unknown as {
        fail(row: RoleRunRow, interrupted: boolean, cause?: unknown): Promise<void>;
    }).fail(claimed, interrupted, cause);
    return { service, row, db, infer, get, change, fail };
}

describe('System role failure diagnostics', () => {
    it.each(['unselected tool', 'delegated subset', 'invalid arguments'])('persists the MCP rejection reason without dispatch for %s', async scenario => {
        const target = { runtime: 'server' as const, assetId: 'own-echo', version: 1, manifest: 'a'.repeat(64), discoveryId: '00000000-0000-0000-0000-000000000001' };
        const tools = ['echo', 'other-echo'].map(name => ({ ...normalizeRoleMcpTool({ name, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }), toolKey: roleMcpToolKey(target, name) }));
        const selected = scenario === 'delegated subset' ? tools : [tools[0]];
        const prepared = [{ target: { ...target, tools: selected.map(({ name, schemaDigest }) => ({ name, schemaDigest })) }, tools: selected }];
        const infer = vi.fn(async () => JSON.stringify({ kind: 'tool', toolKey: tools[scenario === 'invalid arguments' ? 0 : 1].toolKey, arguments: scenario === 'invalid arguments' ? [] : { text: 'own QA text' } }));
        const call = vi.fn(async () => { throw new Error('Unexpected external MCP dispatch'); }), trace = vi.fn();
        const f = fixture({ phase: 'model_step', calls_started: 1 }), budget = { calls: 0, outputBytes: 0, stopped: false };
        await withRoleMcpTools([], prepared, scenario === 'delegated subset' ? [tools[0].toolKey] : undefined, budget, infer, call, async () => {}, trace)
            .catch(cause => f.fail(cause));
        expect(f.row).toMatchObject({ state: 'failed', phase: 'failed', calls_started: 1, facts: [{ id: 'saved' }] });
        expect(f.row.message).toContain('неразрешённый MCP-инструмент');
        expect(f.row.message).toContain('Вызов MCP заблокирован');
        expect(f.row.message).toContain('подтвердите контекст');
        expect(f.row.message).toContain('Автоматического повтора нет');
        expect(f.row.message).not.toContain('Контекст, версия или состояние запуска изменились');
        expect(infer).toHaveBeenCalledTimes(1); expect(call).not.toHaveBeenCalled(); expect(trace).not.toHaveBeenCalled(); expect(budget.calls).toBe(0);
    });

    it.each([
        [new ForbiddenException({ code: 'feature-disabled', message: 'private feature name' }), 'Функция отключена', 'Включите'],
        [new UnauthorizedException('private actor token'), 'Авторизация', 'Войдите'],
        [new ForbiddenException('private permission'), 'Доступ', 'права'],
        [new ConflictException('private conflict'), 'Контекст, версия или состояние', 'заново'],
        [new BadRequestException('Оценка контекста с резервом для ответа превышает настроенное окно модели. Уменьшите сообщение или начните новый диалог.'), 'Окно контекста модели', 'резерв ответа'],
        [new BadRequestException('Уменьшите выбранный контекст.'), 'Контекст превышает', 'Уменьшите'],
        [new BadRequestException('Сообщение с содержимым файлов превышает предел 128 КиБ текста.'), 'Контекст превышает', 'Уменьшите'],
        [new BadRequestException('Контекст превышает предел запроса 8 МиБ. Начните новый диалог.'), 'Контекст превышает', 'Уменьшите'],
        [new BadRequestException('private invalid request'), 'Параметры запроса', 'Проверьте'],
        [new ConflictException('План делегирования не прошёл проверку разрешённых ролей и выбранного контекста.'), 'План координатора', 'проверку'],
        [new ConflictException('Ответ системного агента не прошёл проверку JSON-контракта.'), 'Ответ модели', 'проверку'],
        [new BadRequestException('Модель остановилась на пределе ответа. Ответ не завершён и не принят; автоматического повтора нет. Уменьшите задачу или выберите модель с большим пределом ответа.'), 'Ответ модели оборван', 'предел'],
        [new ServiceUnavailableException('Не удалось проверить доступность функции. Повторите запрос после восстановления сервиса флагов.'), 'доступность функции', 'флагов'],
        [new BadGatewayException('private provider body'), 'Сервис модели или зависимость', 'доступность'],
        [new HttpException('private provider capacity', 429), 'Лимит или очередь', 'позднее'],
        [new HttpException('private provider timeout', 504), 'Сервис модели или зависимость', 'доступность'],
    ])('persists a safe actionable classification for %s', async (cause, category, action) => {
        const f = fixture(); await f.fail(cause);
        expect(f.row).toMatchObject({ state: 'failed', phase: 'failed', calls_started: 0, facts: [{ id: 'saved' }], result: null });
        expect(f.row.message).toContain(category); expect(f.row.message).toContain(action);
        expect(f.row.message).toContain('до резервирования шага модели');
        expect(f.row.message).toContain('Автоматического повтора нет');
        expect(f.row.message).not.toContain('private'); expect(f.infer).not.toHaveBeenCalled();
        expect(f.get).toHaveBeenCalledWith('run', f.db, true);
    });

    it('uses fresh fenced progress instead of the stale claimed row and does not assert dispatch', async () => {
        const f = fixture({ phase: 'validating_context', calls_started: 0 }), claimed = { ...f.row };
        f.row.phase = 'model_step'; f.row.calls_started = 2;
        await f.fail(new Error('unknown'), false, claimed);
        expect(f.row.message).toContain('Этап: шаг модели');
        expect(f.row.message).toContain('Зарезервировано шагов модели: 2');
        expect(f.row.message).toContain('не подтверждает отправку запроса');
        expect(f.row.message).not.toContain('до резервирования'); expect(f.infer).not.toHaveBeenCalled();
    });

    it.each([
        new Error('Bearer secret-token /Users/private/path https://provider.test?key=secret'),
        { status: 503, message: 'Bearer secret-token', code: 'feature-disabled' },
        new HttpException({ message: ['Bearer secret-token'], code: 'unknown-secret-code', body: '/Users/private/path' }, 500),
        new Error('План делегирования не прошёл проверку разрешённых ролей и выбранного контекста.'),
        new Error('Системный агент выбрал недоступный инструмент или неверные аргументы MCP.'),
    ])('keeps unknown causes and non-HTTP lookalikes private: %s', async cause => {
        const f = fixture({ phase: 'Bearer secret-token /Users/private/path' }); await f.fail(cause);
        expect(f.row.message).toContain('Причина сбоя не определена');
        expect(f.row.message).not.toMatch(/secret|Bearer|\/Users|https:|unknown-secret|План координатора/);
        expect(f.row.message).toContain('Этап: исполнение'); expect(f.infer).not.toHaveBeenCalled();
    });

    it('preserves the specific planning timeout and explicit restart action', async () => {
        const f = fixture({ phase: 'model_step', calls_started: 1 }); await f.fail(new SystemRoleStepTimeout('planning'));
        expect(f.row.message).toContain('Координатор не дождался плана');
        expect(f.row.message).toContain('Проверьте подключение компьютера и доступность модели');
        expect(f.row.message).toContain('явно запустите задачу снова'); expect(f.infer).not.toHaveBeenCalled();
    });

    it('preserves interrupted semantics without exposing an abort reason', async () => {
        const f = fixture(); await f.fail(new Error('secret abort reason'), true);
        expect(f.row).toMatchObject({ state: 'interrupted', phase: 'interrupted', message: 'Исполнение прервано. Новый вызов требует явного запуска.' });
        expect(f.infer).not.toHaveBeenCalled();
    });

    it.each(['cancelled', 'succeeded', 'failed', 'interrupted', 'awaiting_review'] as const)('does not overwrite %s', async state => {
        const f = fixture({ state, message: 'retained' }); await f.fail(new Error('secret'));
        expect(f.change).not.toHaveBeenCalled(); expect(f.row.message).toBe('retained'); expect(f.infer).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer lease', async () => {
        const f = fixture(), claimed = { ...f.row }; f.row.lease_token = 'new-lease';
        await f.fail(new Error('secret'), false, claimed);
        expect(f.change).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
    });

    it('does not recreate a missing run', async () => {
        const f = fixture(); f.get.mockResolvedValue(null); await f.fail(new Error('secret'));
        expect(f.change).not.toHaveBeenCalled(); expect(f.infer).not.toHaveBeenCalled();
    });
});
