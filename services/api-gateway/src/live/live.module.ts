import { Global, Module } from '@nestjs/common';
import { LiveService } from './live.service';
import { LiveController } from './live.controller';
@Global()
@Module({
    providers: [LiveService],
    controllers: [LiveController],
    exports: [LiveService],
})
export class LiveModule {}
