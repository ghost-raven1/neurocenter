import {
    Controller,
    ForbiddenException,
    Get,
    Header,
    Headers,
    NotFoundException,
    Param,
    Req,
    Res,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { normalizeOpenCodeInstallSupply, type OpenCodeInstallSupply } from '../../../shared/opencode-cli-install.cjs';
import { BridgeSupplyService } from './bridge-supply.service';

/** Catalog approves installation against the same current supply that Gateway actually serves. */
@Controller('internal/bridge/opencode-cli-supply')
export class OpenCodeCliSupplyController {
    constructor(private readonly bridge: BridgeSupplyService) {}
    @Get(':target')
    @Header('Cache-Control', 'no-store')
    async current(
        @Headers('x-neurocenter-internal') token: string,
        @Param('target') target: string,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<OpenCodeInstallSupply> {
        const expected = process.env.NEUROCENTER_INTERNAL_TOKEN || '';
        if (
            !expected ||
            typeof token !== 'string' ||
            Buffer.byteLength(expected) !== Buffer.byteLength(token) ||
            !timingSafeEqual(Buffer.from(expected), Buffer.from(token))
        )
            throw new ForbiddenException();
        if (!/^(darwin|linux)-(x64|arm64)(-musl)?$/.test(target))
            throw new NotFoundException('Поставка OpenCode для этой платформы не найдена.');
        const abort = new AbortController(),
            cancel = () => {
                if (!res.writableEnded) abort.abort();
            };
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
        req.once('aborted', cancel);
        res.once('close', cancel);
        try {
            signal.throwIfAborted();
            const supply = await this.bridge.supply(signal),
                artifact = supply.artifacts.find((value) => value.target === target);
            const probe = artifact?.metadata.probeEngine as
                { file?: unknown; version?: unknown; sha256?: unknown } | undefined;
            if (!artifact || probe?.file !== 'bin/opencode-probe')
                throw new NotFoundException('Мост не содержит проверенную поставку OpenCode.');
            try {
                return normalizeOpenCodeInstallSupply({
                    buildId: supply.buildId,
                    target,
                    version: probe.version,
                    sha256: probe.sha256,
                });
            } catch {
                throw new NotFoundException('Поставка OpenCode не поддерживает установку через мост.');
            }
        } finally {
            req.off('aborted', cancel);
            res.off('close', cancel);
        }
    }
}
