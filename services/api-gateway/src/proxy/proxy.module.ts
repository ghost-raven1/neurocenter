import { Module } from '@nestjs/common';

import { AuthGuardService } from '../auth/auth-guard.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ConfigService } from '@nestjs/config';
import { McpHostService } from '../features/mcp-host/host';
import { McpHostController } from '../features/mcp-host/mcp-host.controller';
import {ResearchMcpController} from '../features/research-mcp/research-mcp.controller';
import {SystemRoleMcpGatewayController} from '../features/system-role-mcp/system-role-mcp.controller';

/**
 * Модуль: auth-guard + проксирование /api/* на каталожный microservice.
 */
@Module({
    controllers: [ProxyController, McpHostController,ResearchMcpController,SystemRoleMcpGatewayController],
    providers: [
        ProxyService,
        AuthGuardService,
        {
            provide: 'MCP_HOST',
            useFactory: (configService: ConfigService) =>
                new McpHostService(configService.get('CATALOG_SERVICE_URL', 'http://localhost:4100') ?? 'http://localhost:4100', configService.get('NEUROCENTER_INTERNAL_TOKEN', '') ?? ''),
            inject: [ConfigService],
        },
    ],
})
export class ProxyModule {}
