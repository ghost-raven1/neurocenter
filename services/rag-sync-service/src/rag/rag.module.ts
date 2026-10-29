import { Module } from '@nestjs/common';

import { RagController } from './rag.controller';
import { ProjectDatabases } from './project-databases';
import { RagService } from './rag.service';
import { ProjectRagController } from './project-rag.controller';
import {DatabaseLifecycle} from '../retired-databases/database-lifecycle';
import {DatabaseLifecycleController} from '../retired-databases/lifecycle.controller';
import {PlatformQuotaController} from './quota/platform-quota.controller';
import {ProjectTextController} from '../project-text/text.controller';

/**
 * Модуль RAG-дельта-синхронизации (postgres + pgvector).
 */
@Module({
    controllers: [RagController,ProjectRagController,ProjectTextController,DatabaseLifecycleController,PlatformQuotaController],
    providers: [RagService, ProjectDatabases,DatabaseLifecycle],
    exports:[ProjectDatabases],
})
export class RagModule {}
