import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { AccessDb } from '../access/access-db';
import { withModelUsage } from '../model-usage/model-usage.context';
import { ModelsService } from './models.service';
import { RemoteConnectionService } from './remote-connection.service';
import { isRemoteModel } from './remote-model.utils';

const CHECK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * 8.19 P2-3: фоновая автопроверка удалённой модели после сохранения подключения или личного доступа.
 * Запускается fire-and-forget и не блокирует ответ; на модель не более одной одновременной проверки.
 */
@Injectable()
export class ModelAutoVerification {
    private readonly logger = new Logger(ModelAutoVerification.name);
    private readonly inFlight = new Set<string>();
    constructor(
        private readonly models: ModelsService,
        private readonly access: AccessDb,
        private readonly remote: RemoteConnectionService,
    ) {}
    /** Повторный вызов на ту же модель во время проверки игнорируется; ошибка не выходит за пределы лога. */
    schedule(modelId: string, actor: string): void {
        if (!modelId || !actor || this.inFlight.has(modelId)) return;
        this.inFlight.add(modelId);
        void this.run(modelId, actor)
            .catch((error: unknown) => {
                this.logger.warn(
                    `Автопроверка модели ${modelId} не выполнена: ${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => this.inFlight.delete(modelId));
    }
    private async run(modelId: string, actor: string): Promise<void> {
        const model = await this.models.get(modelId);
        if (!isRemoteModel(model) || model.archivedAt) return;
        const head = await this.remote.repository.head(modelId);
        if (!head || head.revoked_at) return;
        const claims = await this.access.claims(actor);
        if (!claims.userRoles.includes('Главный админ')) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
        try {
            // Hosting-команды доступны только главному администратору; права перечитываются внутри проверки.
            await withModelUsage({ purpose: 'verification', actorEmail: actor, actorRole: 'Главный админ' }, () =>
                this.remote.check(
                    model,
                    actor,
                    async () => {
                        controller.signal.throwIfAborted();
                        const current = await this.access.claims(actor);
                        if (!current.userRoles.includes('Главный админ'))
                            throw new ConflictException('Права управления подключением отозваны.');
                    },
                    controller.signal,
                ),
            );
        } finally {
            clearTimeout(timer);
        }
    }
}
