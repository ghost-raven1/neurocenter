import {discussionAttachmentUploadRoute} from '../../shared/discussion-attachment-route.cjs';
import {snapshotContentRoute} from '../../shared/snapshot-content-route.cjs';
import {sourceUploadContentRoute} from '../../shared/source-upload-route.cjs';
import {assetSourceArchiveRoute} from '../../shared/asset-source-archive-route.cjs';
import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';

import { AppModule } from './app.module';

/**
 * Точка входа каталожного microservice.
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, {bodyParser: false});
    app.enableShutdownHooks();
    app.use(createObservability({service:'catalog-service'}).middleware);
    // До 5 МиБ UTF-8 после разбора JSON; экранирование может увеличить тело запроса в шесть раз.
    const jsonParser=express.json({limit:'35mb'});
    app.use((req: import('express').Request,res: import('express').Response,next: import('express').NextFunction)=>{
        if(discussionAttachmentUploadRoute(req.method,req.path)||sourceUploadContentRoute(req.method,req.path)||snapshotContentRoute(req.method,req.path)||assetSourceArchiveRoute(req.method,req.path)){next();return;}
        jsonParser(req,res,next);
    });
    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (req.path.startsWith('/api/') && (!process.env.NEUROCENTER_INTERNAL_TOKEN || req.headers['x-neurocenter-internal'] !== process.env.NEUROCENTER_INTERNAL_TOKEN)) {
            res.status(403).json({message:'Запрос должен пройти через авторизованный шлюз.'}); return;
        }
        next();
    });
    const port = process.env.PORT ? Number(process.env.PORT) : 4100;

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');
    // eslint-disable-next-line no-console
    console.log(`[catalog-service] listening on :${port}`);
}

void bootstrap();
