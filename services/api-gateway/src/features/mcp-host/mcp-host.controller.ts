import {
    All,
    BadGatewayException,
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    HttpCode,
    Injectable,
    Param,
    Post,
    Req,
    Res,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Request, Response } from 'express';
import { AuthGuardService } from '../../auth/auth-guard.service';
import { McpHostService } from './host';
import { issueHostedMcpTicket, verifyHostedMcpTicket, validHostedMcpSession } from './ticket';

/**
 * Хост управляемых MCP-серверов: подключение проходит по устройству, далее OpenCode ходит по билету.
 * Байты артефакта площадка берёт у каталога по внутреннему токену; процесс живёт здесь, а не на машине пользователя.
 */
@Injectable()
@Controller('api/mcp-host')
export class McpHostController {
    private readonly host: McpHostService;
    private readonly catalogUrl: string;

    constructor(
        private readonly authGuard: AuthGuardService,
        configService: ConfigService,
    ) {
        this.catalogUrl = (configService.get<string>('CATALOG_SERVICE_URL') || 'http://localhost:4100').replace(
            /\/+$/,
            '',
        );
        this.host = new McpHostService(this.catalogUrl, process.env.NEUROCENTER_INTERNAL_TOKEN || '');
    }
    async onModuleDestroy(): Promise<void> {
        await this.host.onModuleDestroy();
    }

    /** Мост обменивает устройство и одобренный пакет на билет хоста; OpenCode не получает токен устройства. */
    @Post('connect')
    @HttpCode(200)
    async connect(@Req() req: Request, @Body() body: unknown): Promise<{ path: string }> {
        const auth = await this.authGuard.authenticate(req);
        if (!auth?.deviceId) {
            throw new UnauthorizedException('MCP не подключён или доступ отозван.');
        }
        const input = body as { projectId?: unknown; pkg?: unknown } | null;
        if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            typeof input.projectId !== 'string' ||
            !input.projectId ||
            !input.pkg ||
            typeof input.pkg !== 'object' ||
            Array.isArray(input.pkg)
        ) {
            throw new BadRequestException('Некорректный запрос подключения хоста MCP.');
        }
        const response = await axios.post(
            `${this.catalogUrl}/internal/device-channel/mcp-host/authorize`,
            { projectId: input.projectId, pkg: input.pkg },
            {
                timeout: 15000,
                validateStatus: () => true,
                maxBodyLength: 4 * 1024 * 1024,
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                    authorization: req.headers.authorization,
                },
            },
        );
        if (response.status === 401) {
            throw new UnauthorizedException('MCP не подключён или доступ отозван.');
        }
        if (response.status >= 500) {
            throw new BadGatewayException('Сервис хоста MCP недоступен. Повторите позже.');
        }
        if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
            throw new ForbiddenException('Подключение хоста MCP не разрешено.');
        }
        const data = response.data as { assetId?: unknown; name?: unknown; artifact?: unknown; session?: unknown };
        const artifact = data.artifact as
            | {
                  sha256?: unknown;
                  entrypoint?: unknown;
                  executable?: unknown;
                  compressedBytes?: unknown;
                  unpackedBytes?: unknown;
                  filesCount?: unknown;
              }
            | undefined;
        if (
            typeof data.assetId !== 'string' ||
            typeof data.name !== 'string' ||
            !data.name ||
            data.name.length > 200 ||
            !artifact ||
            typeof artifact.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
            typeof artifact.entrypoint !== 'string' ||
            !artifact.entrypoint ||
            artifact.entrypoint.includes('..') ||
            artifact.entrypoint.startsWith('/') ||
            typeof artifact.executable !== 'boolean' ||
            !Number.isSafeInteger(artifact.compressedBytes as number) ||
            (artifact.compressedBytes as number) < 1 ||
            (artifact.compressedBytes as number) > 2 * 1024 * 1024 * 1024 ||
            !validHostedMcpSession(data.session) ||
            data.session.deviceId !== auth.deviceId ||
            data.session.projectId !== input.projectId ||
            data.session.assetId !== data.assetId
        ) {
            throw new BadGatewayException('Сервис хоста MCP ответил некорректно. Повторите позже.');
        }
        const ticket = issueHostedMcpTicket({
            artifactSha256: artifact.sha256,
            entrypoint: artifact.entrypoint,
            executable: artifact.executable,
            compressedBytes: artifact.compressedBytes as number,
            session: data.session,
            ...(Number.isSafeInteger(artifact.unpackedBytes)
                ? { unpackedBytes: artifact.unpackedBytes as number }
                : {}),
            ...(Number.isSafeInteger(artifact.filesCount) ? { filesCount: artifact.filesCount as number } : {}),
            name: data.name,
        });
        return { path: `/api/mcp-host/m/${ticket}` };
    }

    /** Канал OpenCode: только валидный билет, без cookie и токена устройства. */
    @All('m/:ticket')
    async channel(@Req() req: Request, @Res() res: Response, @Param('ticket') ticket: string): Promise<void> {
        const claim = verifyHostedMcpTicket(ticket);
        if (!claim) {
            res.status(401).json({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Соединение MCP истекло. Повторите установку.' },
                id: null,
            });
            return;
        }
        try {
            await this.host.handle(claim, req, res);
        } catch {
            if (!res.headersSent && !res.writableEnded) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Хост MCP недоступен.' },
                    id: null,
                });
            }
        }
    }
}
