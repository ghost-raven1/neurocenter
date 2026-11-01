import { BadRequestException, ForbiddenException, ConflictException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import {
    OPENCODE_PERSONAL_KEY_JOB,
    OPENCODE_PERSONAL_KEY_CAPABILITY,
    normalizeOpenCodePersonalKeyPayload,
    normalizeOpenCodePersonalKeyContext,
    normalizeOpenCodePersonalKeyReceipt,
    type IOpenCodePersonalKeyPayload,
} from '../../../shared/opencode-personal-key.cjs';
import { DeviceStore, digest } from '../devices/device-store';
import type { IJob } from '../devices/device-job.model';
import { freshGlobalProvidersAccess } from '../devices/global-provider-jobs';
import { ModelsService } from '../models/models.service';
import { RemoteProviderAccessService } from '../remote-providers/remote-provider.service';
import { remoteProviderMutation } from '../remote-providers/remote-provider.identity';
import type { IRemoteProviderActor, IRemoteProviderReceipt } from '../remote-providers/remote-provider.interfaces';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { personalKeyTarget } from './target';
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const denied = () => new ForbiddenException('Перенос относится к вашему действующему компьютеру и личному доступу.');
/** Device-only write channel: the browser and public job never receive the credential or its digest. */
@Injectable()
export class OpenCodePersonalKeyService {
    constructor(
        private readonly devices: DeviceStore,
        private readonly models: ModelsService,
        private readonly personal: RemoteProviderAccessService,
    ) {}
    private input(raw: unknown, save = false) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new BadRequestException('Нужен идентификатор переноса.');
        const value = raw as Record<string, unknown>;
        if (
            !uuid(value.jobId) ||
            Object.keys(value).some((key) => !['jobId', ...(save ? ['apiKey'] : [])].includes(key))
        )
            throw new BadRequestException('Некорректный запрос переноса.');
        return { jobId: value.jobId, apiKey: value.apiKey };
    }
    private async transaction<T>(action: (db: PoolClient) => Promise<T>) {
        const db = await this.devices.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL lock_timeout='1s'");
            await db.query("SET LOCAL statement_timeout='3s'");
            const result = await action(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            await db.query('ROLLBACK').catch(() => {
                discard = true;
            });
            throw error;
        } finally {
            db.release(discard);
        }
    }
    /** Device precedes job, then personal authority: revocation cannot interleave a committed transfer. */
    private async job(
        db: PoolClient,
        id: string,
        bearer: string | undefined,
        actor: IRemoteProviderActor | undefined,
        write: boolean,
        exclusive = false,
    ) {
        if (bearer !== undefined && !/^[a-f0-9]{64}$/.test(bearer)) throw denied();
        const device = (
            await db.query<{ id: string; email: string; role: string; report: { capabilities?: string[] } }>(
                `SELECT device.* FROM bridge_devices device JOIN bridge_jobs job ON job.device_id=device.id WHERE job.id=$1 AND job.email=device.email AND NOT device.revoked AND device.expires_at>clock_timestamp() AND ($2::text IS NULL OR device.token_hash=$2) AND ($3::text IS NULL OR device.email=$3) FOR SHARE OF device`,
                [id, bearer === undefined ? null : digest(bearer), actor?.email ?? null],
            )
        ).rows[0];
        if (!device) throw denied();
        const job = (
            await db.query<IJob>(
                'SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND kind=$4 AND project_id IS NULL FOR ' +
                    (exclusive ? 'UPDATE' : 'SHARE'),
                [id, device.id, device.email, OPENCODE_PERSONAL_KEY_JOB],
            )
        ).rows[0];
        if (!job) throw denied();
        const payload = normalizeOpenCodePersonalKeyPayload(job.payload);
        if (payload.deviceId !== device.id) throw denied();
        const expired =
            write || exclusive
                ? (
                      await db.query<{ expired: boolean }>('SELECT clock_timestamp() >= $1::timestamptz AS expired', [
                          payload.expiresAt,
                      ])
                  ).rows[0]?.expired
                : false;
        if ((write || exclusive) && typeof expired !== 'boolean') throw denied();
        if (write) {
            if (
                !['running', 'succeeded'].includes(job.state) ||
                expired ||
                !device.report.capabilities?.includes(OPENCODE_PERSONAL_KEY_CAPABILITY)
            )
                throw new ConflictException('Сессия переноса истекла или отменена.');
            await freshGlobalProvidersAccess(db, job);
            await requireFeaturesEnabled([
                'computer_setup',
                'computer_connections',
                'personal_remote_provider_credentials',
                'opencode_personal_key_transfer',
            ]);
        }
        return {
            job,
            payload,
            expired,
            actor: actor ?? { email: job.email, activeRole: write ? job.role : device.role },
        };
    }
    async context(bearer: string, raw: unknown) {
        const input = this.input(raw);
        return this.transaction(async (db) => {
            const current = await this.job(db, input.jobId, bearer, undefined, true);
            const target = await personalKeyTarget(db, current.actor, current.payload);
            return normalizeOpenCodePersonalKeyContext({
                ok: true,
                expiresAt: current.payload.expiresAt,
                requestKey: current.payload.requestKey,
                recipient: target.recipient,
            });
        });
    }
    private projection(jobId: string, payload: IOpenCodePersonalKeyPayload, result: IRemoteProviderReceipt | null) {
        if (!result) return null;
        if (
            result.modelId !== payload.modelId ||
            result.providerId !== payload.providerId ||
            result.requestKey !== payload.requestKey ||
            result.connectionRevision !== payload.expectedConnectionRevision ||
            result.credentialRevision !== payload.expectedCredentialRevision + 1 ||
            !result.hasKey
        )
            throw new ConflictException('Квитанция относится к другому переносу.');
        return normalizeOpenCodePersonalKeyReceipt({
            schemaVersion: 1,
            jobId,
            modelId: result.modelId,
            providerId: result.providerId,
            requestKey: result.requestKey,
            connectionRevision: result.connectionRevision,
            credentialRevision: result.credentialRevision,
            hasKey: true,
            acceptedAt: result.acceptedAt,
        });
    }
    async save(bearer: string, raw: unknown) {
        const input = this.input(raw, true),
            current = await this.transaction((db) => this.job(db, input.jobId, bearer, undefined, true));
        const model = await this.models.get(current.payload.modelId);
        const mutation = remoteProviderMutation(
            {
                providerId: current.payload.providerId,
                expectedConnectionRevision: current.payload.expectedConnectionRevision,
                expectedCredentialRevision: current.payload.expectedCredentialRevision,
                requestKey: current.payload.requestKey,
                apiKey: input.apiKey,
            },
            'save',
        );
        const result = await this.personal.repository.mutate(model, current.actor, mutation, 'save', {
            transferJobId: input.jobId,
            authorize: async (db) => {
                const fresh = await this.job(db, input.jobId, bearer, undefined, true);
                if (
                    JSON.stringify(fresh.payload) !== JSON.stringify(current.payload) ||
                    fresh.job.role !== current.job.role
                )
                    throw denied();
                await personalKeyTarget(db, fresh.actor, fresh.payload, false);
            },
        });
        return this.projection(input.jobId, current.payload, result);
    }
    async receipt(bearer: string, raw: unknown) {
        const input = this.input(raw);
        return this.readReceipt(input.jobId, bearer);
    }
    async browserReceipt(req: Request, modelId: string, jobId: string) {
        if (!uuid(jobId)) throw new BadRequestException('Нужен идентификатор переноса.');
        const actor = await this.models.actor(req);
        await this.models.getAccessible(modelId, req);
        return this.readReceipt(jobId, undefined, actor, modelId);
    }
    private async readReceipt(jobId: string, bearer?: string, actor?: IRemoteProviderActor, modelId?: string) {
        const current = await this.transaction((db) => this.job(db, jobId, bearer, actor, false));
        if (modelId && current.payload.modelId !== modelId) throw denied();
        let canStartNew = false;
        const result = await this.personal.repository.receipt(
            current.payload.modelId,
            current.actor,
            current.payload.requestKey,
            {
                transferJobId: jobId,
                authorize: async (db) => {
                    const fresh = await this.job(db, jobId, bearer, actor, false, !!actor);
                    canStartNew = !!fresh.expired || ['failed', 'cancelled'].includes(fresh.job.state);
                    if (JSON.stringify(fresh.payload) !== JSON.stringify(current.payload)) throw denied();
                },
            },
        );
        const receipt = this.projection(jobId, current.payload, result);
        return actor ? { receipt, canStartNew: !!receipt || canStartNew } : { receipt };
    }
}
