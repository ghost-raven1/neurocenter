import { Module } from '@nestjs/common';

import { RagController } from './rag.controller';
import { ProjectDatabases } from './project-databases';
import { RagService } from './rag.service';

/**
 * Модуль RAG-дельта-синхронизации (postgres + pgvector).
 */
@Module({
    controllers: [RagController],
    providers: [RagService, ProjectDatabases],
    exports:[ProjectDatabases],
})
export class RagModule {}
