import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { roleDefinitionPin, roleHash, systemRole } from './system-role.definitions';
import type { SystemRolePolicy } from './system-role.policy';
import type { SystemRoleRepository } from './system-role.repository';
import type { SystemRoleTargets } from './system-role.targets';
import type { RoleRunRow } from './system-role.types';

function ownerRequestKey(action: string, target: string): string {
    const hash = roleHash({ action, target }); return [hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join('-');
}
/** Human application is journalled before calling the existing owner; unknown acknowledgements never repeat writes. */
export class SystemRoleApplication {
    constructor(private readonly repository: SystemRoleRepository, private readonly policy: SystemRolePolicy, private readonly targets: SystemRoleTargets,
        private readonly features = requireFeaturesEnabled) {}
    async apply(req: Request, input: RoleRunRow, revision: number, requestId: string, rollback = false): Promise<RoleRunRow> {
        const actor = await this.policy.actor(req, input.project_id);
        if (!rollback) await this.features([systemRole(input.agent_id).flag, ...(input.request.sourceFeature ? [input.request.sourceFeature] : [])]);
        const intent = await this.repository.transaction(async db => {
            const current = await this.repository.get(input.id, db, true);
            if (!current) throw new ConflictException('Задание недоступно.');
            await this.policy.authorize(db, actor, current.project_id);
            if (current.state === 'applying' || !rollback && current.state === 'succeeded' || rollback && current.phase === 'rolled_back') return { row: current, started: false, unconfirmed: false };
            if (!rollback && current.request.expectedDefinitionPin !== roleDefinitionPin(current.agent_id)) throw new ConflictException('Определение агента изменилось. Подготовьте предложение заново.');
            if (current.revision !== revision || (rollback ? !['succeeded','failed','interrupted'].includes(current.state) || !current.applied.length
                : current.state !== 'awaiting_review' || current.result?.kind !== 'proposal' || !current.result.changes.length)) throw new ConflictException('Предложение изменилось. Обновите результат перед действием.');
            if (!rollback && current.result!.changes.some(change => !current.snapshot.targets.find(target => target.key === change.targetKey)?.editable)) throw new ConflictException('Для этой цели доступно предложение. Применение выполняется через её владельца.');
            const unconfirmed = rollback && current.phase === 'unconfirmed';
            return { row: await this.repository.change(db, current, 'applying', rollback ? 'rolling_back' : 'applying', rollback ? 'Проверяем версии для отката.' : 'Человек подтвердил применение проверенного предложения.'), started: true, unconfirmed };
        });
        const row = intent.row; if (!intent.started) return row;
        try {
            const changes = rollback ? row.result!.changes.filter(change => row.applied.some(receipt => receipt.targetKey === change.targetKey)).reverse() : row.result!.changes;
            for (const change of changes) {
                await this.policy.actor(req, row.project_id);
                if (!rollback) await this.features([systemRole(row.agent_id).flag, ...(row.request.sourceFeature ? [row.request.sourceFeature] : [])]);
                await this.repository.transaction(async db => {
                    const current = await this.repository.applying(row.id, row.phase, db);
                    await this.policy.authorize(db, await this.policy.actor(req, current.project_id), current.project_id);
                });
                const target = row.snapshot.targets.find(item => item.key === change.targetKey)!;
                const receipt = await this.targets.write(req, row.snapshot, target, change.replacement, ownerRequestKey(requestId, target.key), rollback ? row.applied.find(item => item.targetKey === target.key) : undefined);
                await this.repository.transaction(async db => {
                    const current = await this.repository.applying(row.id, row.phase, db);
                    const applied = rollback ? current.applied.filter(item => item.targetKey !== target.key) : [...current.applied, receipt];
                    await this.repository.change(db, current, 'applying', row.phase, rollback ? 'Владелец подтвердил откат одной цели.' : 'Владелец подтвердил новую версию одной цели.', { applied });
                });
            }
            return await this.repository.transaction(async db => {
                const current = await this.repository.applying(row.id, row.phase, db);
                if (intent.unconfirmed) return this.repository.change(db, current, 'interrupted', 'unconfirmed', 'Подтверждённые изменения отменены. Исход другой записи не подтверждён; проверьте актуальные настройки у владельца.');
                return this.repository.change(db, current, 'succeeded', rollback ? 'rolled_back' : 'applied', rollback ? 'Откат подтверждён владельцами настроек.' : 'Изменение сохранено владельцами. Проверка подключения и доставка выполняются отдельно.');
            });
        } catch {
            return this.repository.transaction(async db => {
                const current = await this.repository.get(row.id, db, true);
                if (!current) throw new ConflictException('Задание недоступно.');
                if (current.state !== 'applying') return current;
                return this.repository.change(db, current, 'interrupted', 'unconfirmed', 'Исход применения не подтверждён. Проверьте актуальные версии у владельцев; повторная запись автоматически не выполняется.');
            });
        }
    }
}
