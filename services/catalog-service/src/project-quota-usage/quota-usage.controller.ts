import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { ProjectQuotaUsageService } from './quota-usage.service';
import type { TQuotaDimension } from './quota-usage-core';

/** Единая internal-точка записи accounting: дельта измерения проекта (AD-D4). */
@Controller('internal')
export class ProjectQuotaUsageController {
    constructor(private readonly usage: ProjectQuotaUsageService) {}

    /**
     * Применить дельту объёма проекта.
     *
     * @param {string} id - id проекта.
     * @param {object} body - { dimension: 'current'|'retention'|'staging', deltaBytes: int ≠ 0, request_key: string }.
     * @returns {Promise<{ used: number }>} счётчик измерения после применения.
     */
    @Post('projects/:id/quota-usage')
    @HttpCode(200)
    async quotaUsage(@Req() req: Request, @Param('id') id: string, @Body() body: unknown): Promise<{ used: number }> {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.usage.record(id, body);
    }

    /**
     * Снимок измерений и лимитов проекта (AD-D2): internal-потребители квот
     * (gateway artifact cache, reconciliation) читают единую точку accounting.
     *
     * @param {string} id - id проекта.
     * @returns {Promise<{ used: Record<TQuotaDimension, number>; limits: Record<TQuotaDimension, number> }>}
     */
    @Get('projects/:id/quota-usage')
    async quotaUsageSnapshot(@Req() req: Request, @Param('id') id: string): Promise<{
        used: Record<TQuotaDimension, number>;
        limits: Record<TQuotaDimension, number>;
    }> {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.usage.snapshot(id);
    }
}
