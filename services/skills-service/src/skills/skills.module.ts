import { Module } from '@nestjs/common';
import path from 'node:path';

import { FsSkillsStorage } from '../storage/fs-skills-storage';
import { SKILLS_STORAGE } from '../storage/skills-storage.interface';

import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { SkillDependenciesController } from './skill-dependencies.controller';
import { deliverSkillAudit } from '../storage/skill-audit';
import { reserveSkillDependencies } from '../storage/skill-dependency-reservation';
import { SkillAssetImportController } from './asset-import.controller';

const storagePath = process.env.SKILLS_STORAGE_PATH
    ? path.resolve(process.env.SKILLS_STORAGE_PATH)
    : path.resolve(process.cwd(), 'skills-service', 'skills-storage');

/**
 * Модуль скиллов: микросервис на файловом хранилище (CephFS-паттерн).
 */
@Module({
    controllers: [SkillsController, SkillDependenciesController, SkillAssetImportController],
    providers: [
        SkillsService,
        // Рабочее хранилище публикует pins только после подтверждения каталога.
        {
            provide: SKILLS_STORAGE,
            useValue: new FsSkillsStorage(storagePath, reserveSkillDependencies, deliverSkillAudit),
        },
    ],
    exports: [SKILLS_STORAGE],
})
export class SkillsModule {}
