import { Module } from '@nestjs/common';

import { AuthGuardService } from '../auth/auth-guard.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';

/**
 * Модуль: auth-guard + проксирование /api/* на каталожный microservice.
 */
@Module({ controllers: [ProxyController], providers: [ProxyService, AuthGuardService] })
export class ProxyModule {}
