import {AgentsController} from '../agents/agents.controller';
import {AgentsService} from '../agents/agents.service';
import {OperationActionsController} from '../operations/operation-actions.controller';
import {OperationActionsService} from '../operations/operation-actions.service';
import {SnapshotVerifierController} from '../snapshots/snapshot-verifier.controller';
import {LegacyRetirementController} from '../asset-sources/legacy-retirement.controller';
import {LegacyRetirementService} from '../asset-sources/legacy-retirement.service';
import {SnapshotService} from '../snapshots/snapshot.service';
import {ProjectSnapshotsController} from '../snapshots/snapshot.controller';
import {RestoreController,RestoreRunnerController} from '../restore/restore.controller';
import {RestoreService} from '../restore/restore.service';
import {SourceUploadController} from '../source-upload/source-upload.controller';
import {RetiredRagController} from '../retired-rag/retired-rag.controller';
import {RetiredRagService} from '../retired-rag/retired-rag.service';
import {SourceUploadService} from '../source-upload/source-upload.service';
import {HostedRagGrantService} from '../models/hosted-rag-grant.service';
import { ModelBundleRuntime } from '../models/model-bundle-runtime';
import { OpenCodeModelImport } from '../models/opencode-model-import';
import { RemoteConnectionController } from '../models/remote-connection.controller';
import { RemoteConnectionService } from '../models/remote-connection.service';
import { ModelRuntime } from '../models/model-runtime';
import { AssetManagementController } from '../asset-sources/asset-management.controller';
import { AssetManagementService } from '../asset-sources/asset-management.service';
import { AssetSourcesController, AssetSupplyController } from '../asset-sources/asset-sources.controller';
import { AssetSourcesService } from '../asset-sources/asset-sources.service';
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
import {McpHostController} from '../devices/mcp-host.controller';
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
import {ProjectEmbeddingService} from '../models/project-embedding.service';
import {ProjectEmbeddingController} from '../models/project-embedding.controller';
import {ProjectRagCoordinator} from '../models/project-rag-coordinator';
import {ProjectRagSyncController,ProjectRagContextController} from '../models/project-rag.controller';
import {ProjectReindexService} from '../models/project-reindex.service';
import {ProjectReindexController,ProjectReindexInferenceController} from '../models/project-reindex.controller';
import {DeviceEmbeddingService} from '../models/device-embedding.service';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SnapshotCommandsController } from './snapshot-commands.controller';
import { SkillDependenciesController } from '../publication/skill-dependencies.controller';
import { SkillAuditController } from '../publication/skill-audit.controller';

/**
 * PostgreSQL-backed каталог и его очереди; файловые скиллы обслуживает skills-service.
 */
@Module({ controllers: [AgentsController,SnapshotVerifierController,LegacyRetirementController,ProjectSnapshotsController,RetiredRagController,RestoreController,RestoreRunnerController,OperationActionsController,SourceUploadController,ProjectRagSyncController,ProjectRagContextController,ProjectReindexController,ProjectReindexInferenceController,AssetManagementController,RemoteConnectionController,AssetSourcesController,AssetSupplyController,MaintenanceController,CatalogController, SnapshotCommandsController, SkillDependenciesController, SkillAuditController, AccessController, ProjectBackupController,DeviceController,McpHostController,InstallPlanController,PackageBuildController,ModelsController,ModelHostingController,ModelInferenceController,ProjectEmbeddingController], providers: [AgentsService,LegacyRetirementService,SnapshotService,RetiredRagService,RestoreService,OperationActionsService,SourceUploadService,HostedRagGrantService,ProjectRagCoordinator,ProjectReindexService,ModelBundleRuntime,OpenCodeModelImport,AssetManagementService,RemoteConnectionService,ModelRuntime,AssetSourcesService,MaintenanceService,RuntimeArtifacts,CatalogService, AccessDb, ProjectBackupService,DeviceStore,DeviceArtifacts,DeviceJobs,DeviceInstallations,InstallPlans,PackageBuildService,ModelsService,ModelHostingService,ProjectEmbeddingService,DeviceEmbeddingService,{provide:OllamaClient,useFactory:()=>new OllamaClient()}], exports:[CatalogService] })
export class CatalogModule {}
