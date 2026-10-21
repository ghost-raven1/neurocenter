import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { SkillsModule } from './skills/skills.module';
import {APP_GUARD} from '@nestjs/core';
import {SkillFeaturePolicyGuard} from './skills/feature-policy.guard';

/**
 * Корневой модуль skills-service.
 */
@Module({
    imports: [SkillsModule],
    controllers: [AppController],
    providers:[{provide:APP_GUARD,useClass:SkillFeaturePolicyGuard}],
})
export class AppModule {}
