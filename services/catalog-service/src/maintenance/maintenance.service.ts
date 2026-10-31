import { ensureCatalogSchema } from '../database/catalog-schema';
import { BadRequestException, ConflictException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setMaintenanceMetrics } from '../../../shared/maintenance-metrics.cjs';
import { createPool } from '../database/pool';
import { securityEvent } from '../access/security-events';
import {
    defaultPolicy,
    nextMaintenanceRun,
    validateMaintenancePolicy,
    type MaintenancePolicy,
} from '../../../shared/maintenance-policy.cjs';

/** Политика и аудит сохраняются одной транзакцией; runtime-квитанции пишет только операторский runner. */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
    private readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },
        'maintenance',
    );
    private timer?: NodeJS.Timeout;
    async onModuleInit(): Promise<void> {
        await ensureCatalogSchema(this.pool);
        await this.pool.query(
            'INSERT INTO maintenance_settings(singleton,policy) VALUES(true,$1) ON CONFLICT DO NOTHING',
            [JSON.stringify(defaultPolicy)],
        );
        const refresh = () => {
            void this.get()
                .then(setMaintenanceMetrics)
                .catch(() => undefined);
        };
        refresh();
        this.timer = setInterval(refresh, 30000);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
        }
        await this.pool.end();
    }
    async get() {
        const settings = (
            await this.pool.query(
                'SELECT revision,policy,updated_at AS "updatedAt" FROM maintenance_settings WHERE singleton',
            )
        ).rows[0] as { revision: number; policy: MaintenancePolicy; updatedAt: string };
        const runs = (
            await this.pool.query(
                'SELECT id,slot,state,error_code AS "errorCode",started_at AS "startedAt",finished_at AS "finishedAt" FROM maintenance_runs ORDER BY started_at DESC LIMIT 10',
            )
        ).rows;
        const candidate = (
            await this.pool.query(
                "SELECT receipt FROM maintenance_runs WHERE state='succeeded' AND receipt->>'verification'='sha256-readback' ORDER BY finished_at DESC LIMIT 1",
            )
        ).rows[0]?.receipt as
            { verifiedAt: string; createdAt: string; backupId: string; storageId: string } | undefined;
        const created = Date.parse(candidate?.createdAt ?? ''),
            checked = Date.parse(candidate?.verifiedAt ?? '');
        const verified =
            candidate &&
            typeof candidate.storageId === 'string' &&
            !!candidate.storageId &&
            typeof candidate.backupId === 'string' &&
            !!candidate.backupId &&
            Number.isFinite(created) &&
            Number.isFinite(checked) &&
            checked >= created &&
            created <= Date.now()
                ? candidate
                : undefined;
        const externalAgeSeconds = verified ? Math.max(0, Math.floor((Date.now() - created) / 1000)) : null;
        return {
            ...settings,
            nextRunAt:
                nextMaintenanceRun(settings.policy, new Date(), runs.find((run) => run.state === 'succeeded')?.slot)
                    ?.at ?? null,
            external: verified ?? null,
            externalAgeSeconds,
            rpoExceeded: externalAgeSeconds === null || externalAgeSeconds > settings.policy.rpoMinutes * 60,
            runs,
        };
    }
    async save(input: { expectedRevision?: unknown; policy?: unknown }, actor: string) {
        if (
            !input ||
            Object.keys(input).some((key) => !['expectedRevision', 'policy'].includes(key)) ||
            !Number.isSafeInteger(input.expectedRevision) ||
            Number(input.expectedRevision) < 0
        ) {
            throw new BadRequestException('Передайте исходную ревизию настроек.');
        }
        let policy: MaintenancePolicy;
        try {
            policy = validateMaintenancePolicy(input.policy);
        } catch (error) {
            throw new BadRequestException((error as Error).message);
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = (
                await client.query('SELECT revision,policy FROM maintenance_settings WHERE singleton FOR UPDATE')
            ).rows[0];
            if (!current || current.revision !== input.expectedRevision) {
                throw new ConflictException(
                    'Настройки уже изменены. Обновите сведения; введённые значения сохранены в форме.',
                );
            }
            const saved = (
                await client.query(
                    'UPDATE maintenance_settings SET policy=$1,revision=revision+1,updated_at=now() WHERE singleton RETURNING revision',
                    [JSON.stringify(policy)],
                )
            ).rows[0];
            await securityEvent(client, {
                actor,
                action: 'maintenance.policy.update',
                resourceId: 'maintenance',
                before: current,
                after: { revision: saved.revision, policy },
            });
            await client.query('COMMIT');
            return { revision: saved.revision, policy };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}
