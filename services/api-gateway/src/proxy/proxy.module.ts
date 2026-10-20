import { Module } from '@nestjs/common';

import { AuthGuardService } from '../auth/auth-guard.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ConfigService } from '@nestjs/config';
import { McpHostService } from '../features/mcp-host/host';
import { McpHostController } from '../features/mcp-host/mcp-host.controller';

/**
 * Модуль: auth-guard + проксирование /api/* на каталожный microservice.
 */
@Module({
    controllers: [ProxyController, McpHostController],
    providers: [
        ProxyService,
        AuthGuardService,
        {
            provide: 'MCP_HOST',
            useFactory: (configService: ConfigService) =>
                new McpHostService(configService.get('NEUROCENTER_CATALOG_URL', 'http://catalog-service:4001') ?? 'http://catalog-service:4001', configService.get('NEUROCENTER_INTERNAL_TOKEN', '') ?? ''),
            inject: [ConfigService],
        },
    ],
})
export class ProxyModule {}
