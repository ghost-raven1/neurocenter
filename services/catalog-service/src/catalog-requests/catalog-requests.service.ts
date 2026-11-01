import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from '../models/models.service';
import { createPool } from '../database/pool';
import { CatalogRequestRepository } from './request.repository';
import type { IRequestDetail, IRequestList, IRequestTarget } from './request.interfaces';
/** Intake records intent; importing, packaging and installing remain explicit existing operations. */
@Injectable()
export class CatalogRequestsService implements OnModuleInit, OnApplicationShutdown {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 5 },
        'catalog-requests',
    );
    readonly repository = new CatalogRequestRepository(this.pool);
    constructor(private readonly access: ModelsService) {}
    async onModuleInit() {
        await this.access.ready();
    }
    async onApplicationShutdown() {
        await this.pool.end();
    }
    async list(req: Request, query: unknown): Promise<IRequestList> {
        return this.repository.list(await this.access.actor(req), query);
    }
    async get(req: Request, id: string): Promise<IRequestDetail> {
        return this.repository.get(await this.access.actor(req), id);
    }
    async targets(req: Request, query: unknown): Promise<{ items: IRequestTarget[] }> {
        return this.repository.targets(await this.access.actor(req), query);
    }
    async create(req: Request, input: unknown): Promise<IRequestDetail> {
        return this.repository.create(await this.access.actor(req), input);
    }
    async edit(req: Request, id: string, input: unknown): Promise<IRequestDetail> {
        return this.repository.edit(await this.access.actor(req), id, input);
    }
    async action(req: Request, id: string, input: unknown): Promise<IRequestDetail> {
        return this.repository.action(await this.access.actor(req), id, input);
    }
}
