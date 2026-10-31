import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { DeviceStore } from '../devices/device-store';
import { DeviceLearningService } from './device-learning.service';
import type { DeviceLearningEnvelope } from './device-learning-auth';
import type {
    LearningExperienceInput,
    LearningObservedExperienceInput,
    LearningHypothesisInput,
} from '../../../shared/project-learning.cjs';

type LearningDeviceTarget = Omit<DeviceLearningEnvelope, 'input'>;
type LearningDeviceMessage<T> = LearningDeviceTarget & { input: T };

/** Gateway's device-only allowlist and a fresh bearer identity protect this narrow transport. */
@Controller('internal/device-channel/learning')
export class DeviceLearningController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly learning: DeviceLearningService,
    ) {}
    private identity(req: Request) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.devices.identity(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    }
    @Post('context') async context(@Req() req: Request, @Body() input: LearningDeviceTarget) {
        return this.learning.context(await this.identity(req), input);
    }
    @Post('record') async record(@Req() req: Request, @Body() input: LearningDeviceMessage<LearningExperienceInput>) {
        return this.learning.record(await this.identity(req), input);
    }
    @Post('observe') async observe(
        @Req() req: Request,
        @Body() input: LearningDeviceMessage<LearningObservedExperienceInput>,
    ) {
        return this.learning.observe(await this.identity(req), input);
    }
    @Post('propose') async propose(@Req() req: Request, @Body() input: LearningDeviceMessage<LearningHypothesisInput>) {
        return this.learning.propose(await this.identity(req), input);
    }
}
