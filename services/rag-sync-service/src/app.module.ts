import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { RagModule } from './rag/rag.module';

/**
 * Корневой модуль rag-sync-service.
 */
@Module({
    imports: [RagModule],
    controllers: [AppController],
})
export class AppModule {}
