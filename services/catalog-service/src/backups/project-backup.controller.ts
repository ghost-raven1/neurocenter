import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProjectBackupService } from './project-backup.service';

/** Разрешения на операции проверяются gateway в области конкретного проекта. */
@Controller('api/projects/:project')
export class ProjectBackupController {
    constructor(private readonly backups: ProjectBackupService) {}
    @Get('backups')
    list(@Param('project') project: string) {
        return this.backups.list(project);
    }
    @Post('backups')
    create(@Param('project') project: string) {
        return this.backups.create(project);
    }
    @Get('backups/:backup/download')
    async download(
        @Param('project') project: string,
        @Param('backup') backup: string,
        @Res() res: Response,
    ): Promise<void> {
        const file = await this.backups.file(project, backup);
        res.download(file.file, file.name);
    }
}
