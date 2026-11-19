import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { CatalogService } from './catalog/catalog.service';
import { checkReadiness } from '../../shared/readiness.cjs';

/** Единственная health-семантика catalog — /ready. */
@Controller()
export class AppController {
    constructor(private readonly catalog: CatalogService) {}
    /** Readiness отражает доступность БД; liveness-эндпоинта нет (liveness = контейнер жив). */
    @Get('ready')
    async ready(): Promise<unknown> {
        const state = await checkReadiness({ postgres: () => this.catalog.ready() });
        if (!state.ok) {
            throw new ServiceUnavailableException(state);
        }
        return state;
    }
}
