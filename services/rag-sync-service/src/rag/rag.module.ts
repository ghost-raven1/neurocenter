import { Module } from '@nestjs/common';

import { RagController } from './rag.controller';
import { ProjectDatabases } from './project-databases';
import { RagService } from './rag.service';
import { ProjectRagController } from './project-rag.controller';

/**
 * Модуль RAG-дельта-синхронизации (postgres + pgvector).
 */
@Module({
    controllers: [RagController,ProjectRagController],
    providers: [RagService, ProjectDatabases],
    exports:[ProjectDatabases],
})
export class RagModule {}
