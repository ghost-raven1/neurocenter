import { Controller, Get,ServiceUnavailableException } from '@nestjs/common';
import {CatalogService} from './catalog/catalog.service';
import {checkReadiness} from '../../shared/readiness.cjs';

/**
 * Health-эндпоинт для healthcheck.
 */
@Controller()
export class AppController {
    constructor(private readonly catalog:CatalogService){}
    /** Readiness отражает доступность БД, liveness остаётся отдельным. */
    @Get('ready')
    async ready():Promise<unknown>{const state=await checkReadiness({postgres:()=>this.catalog.ready()});if(!state.ok){throw new ServiceUnavailableException(state);}return state;}
    /**
     * Health-check.
     *
     * @returns {{ ok: boolean }}
     */
    @Get('health')
    public health(): { ok: boolean } {
        return { ok: true };
    }
}
