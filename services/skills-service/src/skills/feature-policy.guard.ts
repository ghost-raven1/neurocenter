import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { requiredRouteFeatures } from '../../../shared/feature-policy.cjs';
import { FeatureFlagError, requireFeaturesEnabled } from '../../../shared/feature-client.cjs';
/** Native skill publication is gated independently from the browser and Catalog import worker. */
@Injectable()
export class SkillFeaturePolicyGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request>(),
            keys = requiredRouteFeatures(request.method, request.path, request.body);
        if (!keys.length) return true;
        const header = request.headers['x-neurocenter-internal'],
            expected = process.env.NEUROCENTER_INTERNAL_TOKEN;
        if (
            !expected ||
            typeof header !== 'string' ||
            Buffer.byteLength(header) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(header), Buffer.from(expected))
        )
            throw new ForbiddenException('Запрос должен пройти через авторизованный шлюз.');
        try {
            await requireFeaturesEnabled(keys);
        } catch (error) {
            if (error instanceof FeatureFlagError && error.status === 403)
                throw new ForbiddenException({
                    code: error.code,
                    message: error.message,
                    feature: error.feature,
                    blockedBy: error.blockedBy,
                });
            throw new ServiceUnavailableException('Не удалось проверить доступность функции.');
        }
        return true;
    }
}
