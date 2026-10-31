import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { checkReadiness } from '../../shared/readiness.cjs';
import { FlagsService } from './flags/flags.service';

@Controller()
export class AppController {
    constructor(private readonly flags: FlagsService) {}
    @Get('health')
    health(): { ok: boolean } {
        return { ok: true };
    }
    /** Liveness не зависит от БД, readiness отражает фактическое подключение без раскрытия адреса. */
    @Get('ready')
    async ready(): Promise<unknown> {
        const state = await checkReadiness({ postgres: () => this.flags.ready() });
        if (!state.ok) {
            throw new ServiceUnavailableException(state);
        }
        return state;
    }
}
