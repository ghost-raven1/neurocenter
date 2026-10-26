// Apply the gateway TLS setting before bootstrap, including direct node dist/main.js launches.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import {discussionAttachmentUploadRoute} from '../../shared/discussion-attachment-route.cjs';
import {snapshotContentRoute} from '../../shared/snapshot-content-route.cjs';
import {sourceUploadContentRoute} from '../../shared/source-upload-route.cjs';
import {assetSourceArchiveRoute} from '../../shared/asset-source-archive-route.cjs';
import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Server as IoServer } from 'socket.io';
import express from 'express';

import { AuthGuardService } from './auth/auth-guard.service';
import type { Request } from 'express';
import { AppModule } from './app.module';
import {LiveService} from './live/live.service';
import {allowBrowserOrigin,browserSecurity,panelOrigin} from './security/browser-security';
import {sourceUploadConnection} from './proxy/source-upload-stream';
import {setupApiDocumentation} from './docs/setup-api-documentation';

/**
 * Точка входа api-gateway: HTTP (proxy /api) + socket.io real-time (/socket.io).
 *
 * События совпадают с `TSocketHandlers` фронта (operation:progress / operation:state / ...).
 * Инвалидации разделов и личные статусы MCP; состояние заданий сохраняется в PG.
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createObservability({service:'api-gateway'}).middleware);
    app.use(sourceUploadConnection);
    app.use(browserSecurity);
    // Скиллы и RAG-батчи должны проходить через gateway с тем же лимитом, что и в сервисах.
    app.use('/api/device-channel',express.json({limit:'512kb'}));
    const jsonParser=express.json({limit:'50mb'});
    app.use((req: import('express').Request,res: import('express').Response,next: import('express').NextFunction)=>{
        if(discussionAttachmentUploadRoute(req.method,req.path)||sourceUploadContentRoute(req.method,req.path)||snapshotContentRoute(req.method,req.path)||assetSourceArchiveRoute(req.method,req.path)){next();return;}
        jsonParser(req,res,next);
    });
    const port = process.env.PORT ? Number(process.env.PORT) : 4000;

    const io = new IoServer(app.getHttpServer(), {
        path: '/socket.io',
        cors: { origin: panelOrigin(), credentials: true },
        // CORS не ограничивает WebSocket: его Origin проверяется на этапе handshake.
        allowRequest: (req,done) => done(null,allowBrowserOrigin(req.headers.origin)),
    });

    // Соединение получает только собственную комнату после проверки актуальной сессии.
    const auth = app.get(AuthGuardService);
    setupApiDocumentation(app, auth);
    const live=app.get(LiveService);live.attach(io);
    io.use(async (socket,next) => {
        try {
            const request=socket.handshake.auth.token?{headers:{authorization:`Bearer ${String(socket.handshake.auth.token)}`}} as Request:socket.request as Request;
            const user=await auth.authenticate(request);
            if (!user) { next(new Error('Требуется вход в Нейроцентр')); return; }
            socket.data.user=user;socket.data.authRequest=request;
            next();
        } catch { next(new Error('Проверка входа временно недоступна. Повторите подключение позже.')); }
    });
    io.on('connection',socket=>{
        const user=socket.data.user as Awaited<ReturnType<AuthGuardService['authenticate']>>;
        if(!user){socket.disconnect(true);return;}
        void socket.join(user.deviceId?`device:${user.deviceId}`:`user:${user.email}`);
        if(user.deviceId){live.bridge(user.email,user.deviceId);}
        const timer=setInterval(()=>{void auth.authenticate(socket.data.authRequest as Request)
            .then(current=>{if(!current){socket.disconnect(true);}}).catch(()=>{socket.disconnect(true);});},25000);
        socket.on('disconnect',()=>{clearInterval(timer);if(user.deviceId){live.bridge(user.email,user.deviceId);}});
    });

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');
    // eslint-disable-next-line no-console
    console.log(`[api-gateway] listening on :${port}`);
}

void bootstrap();
