import { Body, ConflictException, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from './device-store';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';
import { assertDeviceCatalogAsset } from './device-catalog-access';
import { verifyPackage, type IPackage } from '../catalog/bundle-package';
import { normalizeRuntimeArtifacts } from '../../../shared/runtime-artifacts.cjs';
import { runtimeArtifactTarget } from './runtime-host-target';

/** Хост управляемых MCP-серверов: площадка выдаёт допуск и байты одобренного артефакта. */
@Controller()
export class McpHostController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly runtimeArtifacts: RuntimeArtifacts,
    ) {}

    /** Мост запрашивает допуск: пакет одобрен, проект разрешил инструмент, артефакт платформы хоста существует. */
    @Post('internal/device-channel/mcp-host/authorize')
    async authorize(
        @Headers('x-neurocenter-internal') token: string,
        @Headers('authorization') authorization: string,
        @Body() input: unknown,
    ) {
        assertInternal(token);
        await this.devices.identity(String(authorization || '').replace(/^Bearer /, ''));
        const body = input as { projectId?: unknown; pkg?: IPackage } | null;
        const pkg = body?.pkg ?? null;
        if (body?.projectId === undefined || typeof body.projectId !== 'string' || !body.projectId) {
            throw new ConflictException('Не задан проект подключения.');
        }
        if (
            !pkg || pkg.plugin?.kind !== 'mcp'
            || typeof pkg.plugin.id !== 'string' || !pkg.plugin.id
            || !Array.isArray(pkg.files) || !pkg.manifest || typeof pkg.manifest.sha256 !== 'string'
        ) {
            throw new ConflictException('Только одобренный пакет MCP допустим для хостинга.');
        }
        let valid = false;
        try { valid = verifyPackage(pkg); } catch { /* Повреждённый снимок закрывается отказом. */ }
        if (!valid) { throw new ConflictException('Целостность пакета не подтверждена.'); }
        await assertDeviceCatalogAsset(this.devices.pool, body.projectId, 'mcp', pkg.plugin.id);
        const artifacts = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts);
        if (!artifacts.length) { throw new ConflictException('У MCP нет готового комплекта площадки.'); }
        const hostTarget = runtimeArtifactTarget();
        const artifact = artifacts.find(item => item.target === hostTarget);
        if (!artifact) {
            throw new ConflictException('Для платформы хоста нет одобренного комплекта. Загрузите артефакт и повторите.');
        }
        const { rows } = await this.devices.pool.query(
            'SELECT compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1',
            [artifact.sha256],
        );
        if (!rows[0]
            || Number(rows[0].compressed_bytes) !== artifact.compressedBytes
            || Number(rows[0].unpacked_bytes) !== artifact.unpackedBytes
            || Number(rows[0].files_count) !== artifact.filesCount) {
            throw new ConflictException('Комплект хоста ещё не импортирован на площадке.');
        }
        return {
            assetId: pkg.plugin.id,
            name: pkg.plugin.name,
            artifact: {
                sha256: artifact.sha256,
                target: artifact.target,
                entrypoint: artifact.entrypoint,
                executable: artifact.executable ?? false,
                compressedBytes: artifact.compressedBytes,
            },
        };
    }

    /** Байты архива хост читает только по внутреннему токену и точному SHA-256. */
    @Get('internal/mcp-host/artifact/:sha256')
    async artifact(@Headers('x-neurocenter-internal') token: string, @Res() res: Response, @Param('sha256') sha256: string) {
        assertInternal(token);
        const opened = await this.runtimeArtifacts.open(sha256);
        res.status(200);
        res.setHeader('content-type', 'application/gzip');
        res.setHeader('content-length', String(opened.bytes));
        res.setHeader('cache-control', 'private,no-store');
        opened.stream.pipe(res);
    }
}
