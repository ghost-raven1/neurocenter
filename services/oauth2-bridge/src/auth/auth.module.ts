import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import {OAuthTransactions} from './oauth-transactions.service';

/**
 * Модуль авторизации через Blitz (SSO/OIDC code-flow).
 */
@Module({
    controllers: [AuthController],
    providers: [AuthService, SessionService, OAuthTransactions],
})
export class AuthModule {}
