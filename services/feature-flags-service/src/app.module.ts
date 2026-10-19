import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { FeatureAccess } from './access/feature-access';
import { FlagsController } from './flags/flags.controller';
import { FlagsService } from './flags/flags.service';

@Module({ controllers: [AppController, FlagsController], providers: [FeatureAccess, FlagsService] })
export class AppModule {}
