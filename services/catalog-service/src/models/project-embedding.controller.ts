import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ProjectEmbeddingService } from './project-embedding.service';

/** Настройка выбирает назначенную модель, но не запускает хостинг и не изменяет индекс. */
@Controller('api/projects')
export class ProjectEmbeddingController {
    constructor(private readonly embedding: ProjectEmbeddingService) {}
    @Get(':id/embedding') get(@Req() req: Request, @Param('id') id: string) {
        return this.embedding.get(req, id);
    }
    @Patch(':id/embedding') update(@Req() req: Request, @Param('id') id: string, @Body() input: unknown) {
        return this.embedding.update(req, id, input);
    }
}
