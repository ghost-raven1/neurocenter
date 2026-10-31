import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from './device-store';
import { authorizeHostedMcp, authorizeHostedMcpSession } from './mcp-host-access';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';

/** Хост управляемых MCP-серверов: площадка выдаёт допуск и байты одобренного артефакта. */
@Controller()
export class McpHostController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly runtimeArtifacts: RuntimeArtifacts,
    ) {}

    /** Мост запрашивает допуск: пакет одобрен, проект разрешил инструмент, артефакт платформы хоста существует. */
    @Post('internal/device-channel/mcp-host/authorize')
    @HttpCode(200)
    async authorize(
        @Headers('x-neurocenter-internal') token: string,
        @Headers('authorization') authorization: string,
        @Body() input: unknown,
    ) {
        assertInternal(token);
        const device = await this.devices.identity(String(authorization || '').replace(/^Bearer /, ''));
        return authorizeHostedMcp(this.devices, device, input);
    }

    /** Gateway validates a signed contextual ticket before each tools/list and tools/call. */
    @Post('internal/mcp-host/authorize-session')
    @HttpCode(200)
    async authorizeSession(@Headers('x-neurocenter-internal') token: string, @Body() input: unknown) {
        assertInternal(token);
        return authorizeHostedMcpSession(this.devices, input);
    }

    /** Байты архива хост читает только по внутреннему токену и точному SHA-256. */
    @Get('internal/mcp-host/artifact/:sha256')
    async artifact(
        @Headers('x-neurocenter-internal') token: string,
        @Res() res: Response,
        @Param('sha256') sha256: string,
    ) {
        assertInternal(token);
        const opened = await this.runtimeArtifacts.open(sha256);
        const metadata = (
            await this.devices.pool.query(
                'SELECT unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1',
                [sha256],
            )
        ).rows[0];
        res.status(200);
        res.setHeader('content-type', 'application/gzip');
        res.setHeader('content-length', String(opened.bytes));
        res.setHeader('cache-control', 'private,no-store');
        if (metadata) {
            res.setHeader('x-neurocenter-unpacked-bytes', String(metadata.unpacked_bytes));
            res.setHeader('x-neurocenter-files-count', String(metadata.files_count));
        }
        opened.stream.pipe(res);
    }
}
