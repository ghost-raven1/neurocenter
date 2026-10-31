import { Body, Controller, Delete, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SnapshotService } from '../snapshots/snapshot.service';
import type { SnapshotCommand, SnapshotHead, SnapshotProfileInput } from '../snapshots/snapshot-types';

/** Real verified images, exact CAS and durable command receipts. */
@Controller('api/projects/:id')
export class SnapshotCommandsController {
    constructor(private readonly snapshots: SnapshotService) {}
    @Post('versions/:sid/activate') activateHead(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('sid') sid: string,
        @Body() body: SnapshotCommand & SnapshotHead,
    ) {
        return this.snapshots.commands.move(id, sid, this.snapshots.actor(req), body, 'activate');
    }
    @Post('versions/:sid/rollback') rollbackHead(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('sid') sid: string,
        @Body() body: SnapshotCommand & SnapshotHead,
    ) {
        return this.snapshots.commands.move(id, sid, this.snapshots.actor(req), body, 'rollback');
    }
    @Delete('versions/:sid') deleteSnapshot(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('sid') sid: string,
        @Body() body: SnapshotCommand & { expectedManifest: string | null; gracePeriodHours?: number },
    ) {
        return this.snapshots.commands.remove(id, sid, this.snapshots.actor(req), body);
    }
    @Post('versions/:sid/cancel') cancelSnapshot(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('sid') sid: string,
        @Body() body: SnapshotCommand,
    ) {
        return this.snapshots.commands.cancel(id, sid, this.snapshots.actor(req), body);
    }
    @Post('release-profile') releaseProfile(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: SnapshotProfileInput,
    ) {
        return this.snapshots.commands.release(id, this.snapshots.actor(req), body);
    }
}
