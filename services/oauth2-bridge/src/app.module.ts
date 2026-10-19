import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';

/**
 * Корневой модуль oauth2-bridge (SSO/Blitz login).
 */
@Module({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile:process.env.NODE_ENV==='production' }), AuthModule],
    controllers: [AppController],
})
export class AppModule {}
