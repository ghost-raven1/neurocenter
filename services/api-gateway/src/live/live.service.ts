import { Injectable,OnModuleDestroy } from '@nestjs/common';
import type { Server } from 'socket.io';
import {canonicalAccessRoute} from '../../../shared/access-route.cjs';

/** События несут только инвалидацию; приватные данные всегда читаются через RBAC API. */
@Injectable()
export class LiveService implements OnModuleDestroy {
    private io?: Server;
    /** Закрывает WebSocket и его таймеры до ожидания завершения HTTP-сервера. */
    async onModuleDestroy():Promise<void>{if(this.io){await new Promise<void>(resolve=>this.io!.close(()=>resolve()));}}
    attach(io: Server): void {
        this.io = io;
    }
    sections(sections: string[]): void {
        this.io?.emit('section:changed', {
            sections,
            at: new Date().toISOString(),
        });
    }
    bridge(email: string, deviceId?: string, jobId?: string): void {
        this.io
            ?.to(`user:${email}`)
            .emit('bridge:changed', { deviceId, jobId });
    }
    wake(deviceId: string): void {
        this.io?.to(`device:${deviceId}`).emit('bridge:work');
    }
    mutation(
        path: string,
        email: string,
        data?: Record<string, unknown>,
        method?: string,
    ): void {
        // Presence and read metadata are fetched only by their authorized room audience.
        const route=canonicalAccessRoute(path);
        if(route==='/api/chat-presence/session'||/^\/api\/projects\/[^/]+\/team-chat(?:\/rooms\/[^/]+)?\/activity$/.test(route||''))return;
        // Named dialogue activity is not broadcast to users outside its private audience; authorized clients poll.
        if (/^\/api\/projects\/[^/]+\/team-chat\/rooms(?:\/|$)/.test(path)) return;
        if (/^\/api\/projects\/[^/]+\/team-chat(?:\/|$)/.test(path)) {this.sections(['project_chat']);return;}
        if (/^\/api\/catalog-requests(?:\/|$)/.test(path)) {
            this.sections(['requests', 'audit']);
            return;
        }
        if (path.startsWith('/api/feature-flags')) {
            this.sections(['maintenance','catalog','knowledge','projects','audit']);
            return;
        }
        if (path.startsWith('/api/device-install-plans')) { this.sections(['catalog','audit']); return; }
        if (path.startsWith('/api/device-jobs')) {
            this.bridge(
                email,
                String(data?.deviceId || '') || undefined,
                String(data?.id || '') || undefined,
            );
            if (data?.deviceId) {
                this.wake(String(data.deviceId));
            }
            return;
        }
        if (
            path.startsWith('/api/devices') ||
            path.startsWith('/api/device-pairs')
        ) {
            this.bridge(email);
            return;
        }
        if (/\/members(?:\/|$)|\/platform\/users/.test(path)) {
            this.sections(['access', 'projects', 'catalog', 'audit']);
            this.io?.emit('auth:changed');
            return;
        }
        // A connect response is the server-created job; wake its exact device without sending prompt bytes.
        if (method === 'POST' && /^\/api\/projects\/[^/]+\/agents\/connect\/?$/.test(path)
            && data?.kind === 'configure-project-agents' && typeof data.deviceId === 'string' && data.deviceId
            && typeof data.id === 'string' && data.id) {
            this.bridge(email, data.deviceId, data.id);
            this.wake(data.deviceId);
        }
        if (path.startsWith('/api/projects')) {
            const deleted = method === 'DELETE' && /^\/api\/projects\/[^/]+\/?$/.test(path);
            this.sections([
                'projects',
                'catalog',
                'knowledge',
                'maintenance',
                'operations',
                'audit',
                ...(deleted ? ['access'] : []),
            ]);
            // Вместе с проектом исчезают назначения, включая активную роль пользователя.
            if (deleted) { this.io?.emit('auth:changed'); }
            return;
        }
        if (path.startsWith('/api/ai-plugins')) {
            this.sections(['catalog', 'projects', 'audit']);
            return;
        }
        if (path.startsWith('/api/models') || path.startsWith('/api/agents')) {
            this.sections(['catalog', 'projects', 'operations', 'audit']);
            return;
        }
        if (path.startsWith('/api/skills')) {
            this.sections(['catalog', 'projects', 'audit']);
            return;
        }
        if (path.startsWith('/api/rag')) {
            this.sections(['knowledge', 'projects', 'operations', 'audit']);
            return;
        }
        if (path.startsWith('/api/maintenance')) {
            this.sections(['maintenance', 'projects', 'audit', 'operations']);
            return;
        }
        if (path.startsWith('/api/operations')) {
            this.sections(['operations', 'audit', 'projects']);
        }
    }
}
