import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { SkillsModule } from './skills/skills.module';

/**
 * Корневой модуль skills-service.
 */
@Module({
    imports: [SkillsModule],
    controllers: [AppController],
})
export class AppModule {}
