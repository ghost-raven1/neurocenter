import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModelsService } from '../models/models.service';
import { normalizeProjectQuota } from '../catalog/project-quota';
import {
    parseQuotaUsageInput,
    recordProjectQuotaUsage,
    readProjectQuotaUsage,
    type IQuotaUsageInput,
    type TQuotaDimension,
} from './quota-usage-core';

/**
 * Персистентный per-project used-bytes accounting (AD-D4).
 * Единственная точка записи счётчиков: writers (rag-sync, skills) вызывают
 * internal API, а не пишут в таблицу напрямую (обход = фэйл-тест).
 */
@Injectable()
export class ProjectQuotaUsageService {
    private readonly logger = new Logger('ProjectQuotaUsage');

    constructor(private readonly models: ModelsService) {}

    /**
     * Применить дельту измерения проекта. Идемпотентно по request_key.
     *
     * @param {string} projectId - id проекта.
     * @param {unknown} raw - тело { dimension, deltaBytes, request_key }.
     * @returns {Promise<{ used: number }>} счётчик измерения после применения.
     */
    async record(projectId: string, raw: unknown): Promise<{ used: number }> {
        const input: IQuotaUsageInput = parseQuotaUsageInput(raw);
        const client = await this.models.pool.connect();
        try {
            await client.query('BEGIN');
            try {
                const result = await recordProjectQuotaUsage(client, projectId, input);
                if (result.clamped) {
                    // Дельта-минус больше текущего объёма: счётчик упирается в ноль,
                    // расхождение выявит reconciliation (эпик 5, story 8).
                    this.logger.warn(
                        `дельта квоты ${projectId}/${input.dimension} ${input.deltaBytes} уперлась в ноль (request_key=${input.requestKey})`,
                    );
                }
                await client.query('COMMIT');
                return { used: result.used };
            } catch (error) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw error;
            }
        } finally {
            client.release();
        }
    }

    /** Срез счётчиков: current/retention/staging; пустой проект — нули. */
    async usage(projectId: string): Promise<Record<TQuotaDimension, number>> {
        return readProjectQuotaUsage(this.models.pool, projectId);
    }

    /**
     * Снимок для internal-потребителей (AD-D2): фактические счётчики и лимиты
     * проектов.quota. Отсутствие счётчика — ноль, отсутствие лимита — 0 (безлимит по AD-D4).
     *
     * @param {string} projectId - id проекта.
     * @returns {Promise<{used: Record<TQuotaDimension, number>; limits: Record<TQuotaDimension, number>}>}
     */
    async snapshot(projectId: string): Promise<{
        used: Record<TQuotaDimension, number>;
        limits: Record<TQuotaDimension, number>;
    }> {
        const found = await this.models.pool.query('SELECT quota FROM projects WHERE id=$1', [projectId]);
        if (!found.rowCount) {
            throw new NotFoundException('Проект не найден в каталоге.');
        }
        const quota = normalizeProjectQuota((found.rows[0] as { quota?: unknown }).quota);
        return {
            used: await readProjectQuotaUsage(this.models.pool, projectId),
            limits: {
                current: quota.currentBytesLimit,
                retention: quota.retentionBytesLimit,
                staging: quota.stagingBytesLimit,
            },
        };
    }
}
