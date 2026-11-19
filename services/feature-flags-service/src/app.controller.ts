import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { checkReadiness } from '../../shared/readiness.cjs';
import { FlagsService } from './flags/flags.service';

@Controller()
export class AppController {
    constructor(private readonly flags: FlagsService) {}
    /** Readiness отражает фактическое подключение БД без раскрытия адреса; liveness-эндпоинта нет. */
    @Get('ready')
    async ready(): Promise<unknown> {
        const state = await checkReadiness({ postgres: () => this.flags.ready() });
        if (!state.ok) {
            throw new ServiceUnavailableException(state);
        }
        return state;
    }
}
