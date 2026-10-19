import {MaintenanceController} from '../maintenance/maintenance.controller';
import {MaintenanceService} from '../maintenance/maintenance.service';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';
import { ProjectBackupController } from '../backups/project-backup.controller';
import { ProjectBackupService } from '../backups/project-backup.service';
import { Module } from '@nestjs/common';
import { AccessController } from '../access/access.controller';
import { AccessDb } from '../access/access-db';
import {DeviceStore} from '../devices/device-store';
import {DeviceArtifacts} from '../devices/device-artifacts';
import {DeviceJobs} from '../devices/device-jobs';
import {DeviceController} from '../devices/device.controller';
import {DeviceInstallations} from '../devices/device-installations';
import {InstallPlans} from '../devices/install-plans';
import {InstallPlanController} from '../devices/install-plan.controller';
import {PackageBuildController} from '../package-build/package-build.controller';
import {PackageBuildService} from '../package-build/package-build.service';
import { ModelsController } from '../models/models.controller';
import { ModelsService } from '../models/models.service';
import { ModelHostingController } from '../models/hosting.controller';
import { ModelHostingService } from '../models/hosting.service';
import { ModelInferenceController } from '../models/inference.controller';
import { OllamaClient } from '../models/ollama-client';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SnapshotCommandsController } from './snapshot-commands.controller';
import { SkillDependenciesController } from '../publication/skill-dependencies.controller';
import { SkillAuditController } from '../publication/skill-audit.controller';

/**
 * Модуль каталога: проекты — PG-backed (БД `catalog`), остальное — mock.
 */
@Module({ controllers: [MaintenanceController,CatalogController, SnapshotCommandsController, SkillDependenciesController, SkillAuditController, AccessController, ProjectBackupController,DeviceController,InstallPlanController,PackageBuildController,ModelsController,ModelHostingController,ModelInferenceController], providers: [MaintenanceService,RuntimeArtifacts,CatalogService, AccessDb, ProjectBackupService,DeviceStore,DeviceArtifacts,DeviceJobs,DeviceInstallations,InstallPlans,PackageBuildService,ModelsService,ModelHostingService,{provide:OllamaClient,useFactory:()=>new OllamaClient()}], exports:[CatalogService] })
export class CatalogModule {}
