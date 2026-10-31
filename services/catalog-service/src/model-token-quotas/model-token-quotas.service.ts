import {
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { readFeatures } from '../../../shared/feature-client.cjs';
import { ModelsService } from '../models/models.service';
import { validateModelId } from '../models/model-validation';
import { ModelUsageService } from '../model-usage/model-usage.service';
import { ModelTokenQuotasRepository } from './model-token-quotas.repository';
import { modelTokenQuotaInput, quotaRequestKey, quotaUserEmail } from './model-token-quotas.validation';
import { quotaUnavailable } from './quota-database';
import { quotaRequestText } from './model-token-quotas.model';

/** MainAdmin configuration remains readable while enforcement is OFF; every response rechecks its actor. */
@Injectable()
export class ModelTokenQuotasService {
    readonly repository: ModelTokenQuotasRepository;
    constructor(
        private readonly models: ModelsService,
        usage: ModelUsageService,
    ) {
        this.repository = new ModelTokenQuotasRepository(usage.pool);
    }
    private async current(req: Request, expected?: string): Promise<string> {
        const actor = quotaUserEmail(await this.models.requireMain(req));
        if (expected && actor !== expected)
            throw new ForbiddenException('Учётная запись изменилась. Перечитайте квоту.');
        return actor;
    }
    private async feature(): Promise<boolean> {
        try {
            return (await readFeatures(process.env, globalThis.fetch)).flags.user_model_token_quotas;
        } catch {
            throw quotaUnavailable();
        }
    }
    async read(req: Request, id: string, rawEmail: string) {
        validateModelId(id);
        const email = quotaUserEmail(rawEmail),
            writer = await this.current(req),
            model = await this.models.get(id);
        try {
            const view = await this.repository.read(model, email),
                featureEnabled = await this.feature();
            await this.current(req, writer);
            return { ...view, featureEnabled };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw quotaUnavailable();
        }
    }
    async save(req: Request, id: string, rawEmail: string, raw: unknown) {
        validateModelId(id);
        const email = quotaUserEmail(rawEmail),
            input = modelTokenQuotaInput(raw),
            writer = await this.current(req);
        try {
            // An accepted configuration receipt outlives its catalog row and target account.
            const accepted = await this.repository.accepted(writer, input.requestKey);
            await this.current(req, writer);
            if (accepted) {
                const fingerprint = createHash('sha256')
                    .update(quotaRequestText(writer, id, email, input))
                    .digest('hex');
                if (accepted.requestFingerprint !== fingerprint)
                    throw new ConflictException({
                        code: 'MODEL_TOKEN_QUOTA_REQUEST_CONFLICT',
                        message: 'Ключ уже относится к другой настройке квоты.',
                    });
                return accepted;
            }
            const model = await this.models.get(id);
            const result = await this.repository.save(writer, model, email, input, AbortSignal.timeout(10000));
            await this.current(req, writer);
            return result;
        } catch (error) {
            if (error instanceof HttpException && error.getStatus() < 500) throw error;
            throw new ServiceUnavailableException({
                statusCode: 503,
                code: 'MODEL_TOKEN_QUOTA_SAVE_UNCONFIRMED',
                message:
                    'Сохранение квоты не подтверждено. Перечитайте квитанцию или явно повторите тот же запрос; ввод сохранён.',
            });
        }
    }
    async receipt(req: Request, id: string, rawEmail: string, rawKey: string) {
        validateModelId(id);
        const email = quotaUserEmail(rawEmail),
            key = quotaRequestKey(rawKey),
            writer = await this.current(req);
        try {
            const receipt = await this.repository.receipt(writer, id, email, key);
            await this.current(req, writer);
            return receipt;
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw quotaUnavailable();
        }
    }
}
