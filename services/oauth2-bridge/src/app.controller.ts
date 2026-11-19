import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { checkReadiness, httpReady } from '../../shared/readiness.cjs';

/** Единственная health-семантика oauth2-bridge — /ready (для docker-compose healthcheck). */
@Controller()
export class AppController {
    @Get('ready')
    async ready(): Promise<unknown> {
        const state = await checkReadiness({
            catalog: () => httpReady(process.env.CATALOG_SERVICE_URL || 'http://localhost:4100'),
        });
        if (!state.ok) {
            throw new ServiceUnavailableException(state);
        }
        return state;
    }
}
