import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { assertInternal } from '../access/access.controller';
import { normalizeEmail, type IAccessActor } from '../access/access.model';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import { authorizeAccessWrite } from '../access/access-write-policy';
import { DiscussionsRepository } from '../discussions/discussions.repository';
import { HelpFiles } from './help-files';

/** Article source files are shared with operator tooling; permissions always come from current claims. */
@Injectable()
export class HelpService {
    readonly files = new HelpFiles();
    constructor(
        private readonly access: AccessDb,
        private readonly repository: DiscussionsRepository,
    ) {}
    async actor(req: Request, edit = false): Promise<IAccessActor> {
        assertInternal(req.headers['x-neurocenter-internal']);
        let actor: IAccessActor;
        try {
            actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')));
            actor.email = normalizeEmail(actor.email);
        } catch {
            throw new BadRequestException('Не подтверждён пользователь.');
        }
        const claims = await this.access.claims(actor.email);
        if (!claims.userRoles.includes(actor.activeRole) || (edit && actor.activeRole !== 'Главный админ'))
            throw new ForbiddenException('Недостаточно прав для статьи.');
        return actor;
    }
    async list(req: Request) {
        await this.actor(req);
        const items = await this.files.list(),
            actor = await this.actor(req);
        return { items, canEdit: actor.activeRole === 'Главный админ' };
    }
    async read(req: Request, slug: string) {
        await this.actor(req);
        const article = await this.files.read(slug),
            actor = await this.actor(req);
        return { ...article, canEdit: actor.activeRole === 'Главный админ' };
    }
    async save(req: Request, slug: string, raw: unknown) {
        const actor = await this.actor(req, true);
        await requireFeatureEnabled('help_center');
        if (
            !raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.keys(raw).some((key) => !['content', 'expectedRevision'].includes(key))
        )
            throw new BadRequestException('Передайте текст и исходную ревизию статьи.');
        const input = raw as { content?: unknown; expectedRevision?: unknown };
        const saved = await this.repository.transaction(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72465439))', [
                'help:' + this.files.directory + ':' + slug,
            ]);
            await authorizeAccessWrite(db, actor);
            return this.files.save(slug, input.content, input.expectedRevision);
        });
        return { ...saved, canEdit: true };
    }
}
