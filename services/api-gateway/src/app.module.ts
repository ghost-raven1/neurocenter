import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { ProxyModule } from './proxy/proxy.module';
import { BridgeController } from './bridge/bridge.controller';
import { BridgeSupplyService } from './bridge/bridge-supply.service';
import {LiveModule} from './live/live.module';
import {OpenCodeCliSupplyController} from './bridge/opencode-cli-supply.controller';

/**
 * Корневой модуль api-gateway: front-facing, /api/* → каталожный microservice.
 * Дальше сюда же: auth-guard (cookie), fan-out на остальные микросервисы, WS.
 */
@Module({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile:process.env.NODE_ENV==='production' }), LiveModule, ProxyModule],
    controllers: [AppController, BridgeController, OpenCodeCliSupplyController],
    providers: [BridgeSupplyService],
})
export class AppModule {}
