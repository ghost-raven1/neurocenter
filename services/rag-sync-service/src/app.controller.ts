import { Controller, Get,ServiceUnavailableException } from '@nestjs/common';
import {ProjectDatabases} from './rag/project-databases';
import {checkReadiness} from '../../shared/readiness.cjs';

/**
 * Health-эндпоинт rag-sync-service.
 */
@Controller()
export class AppController {
    constructor(private readonly databases:ProjectDatabases){}
    @Get('ready')
    async ready():Promise<unknown>{const state=await checkReadiness({postgres:()=>this.databases.ready()});if(!state.ok){throw new ServiceUnavailableException(state);}return state;}
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
