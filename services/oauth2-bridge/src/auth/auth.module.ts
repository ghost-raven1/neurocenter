import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { CatalogSessionClient } from './catalog-session.client';
import { OAuthTransactions } from './oauth-transactions.service';

/**
 * Модуль авторизации через Blitz (SSO/OIDC code-flow).
 */
@Module({
    controllers: [AuthController],
    providers: [AuthService, CatalogSessionClient, SessionService, OAuthTransactions],
})
export class AuthModule {}
