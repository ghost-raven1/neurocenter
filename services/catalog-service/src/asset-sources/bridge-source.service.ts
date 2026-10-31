import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { BridgeAsset } from '@neurocenter/asset-contract';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { readModelActor } from '../models/model-access';
import { AssetSourcesService } from './asset-sources.service';
import {
    bridgeReleaseView,
    bridgeSourceUrl,
    readBridgeSource,
    isRetiredBridgeSource,
    retiredBridgeSourceMessage,
} from './bridge-source-feed';
import { BridgeSourceRepository, bridgeSourceRepository, staleBridgeSource } from './bridge-source.repository';
import { importView } from './import-types';
import { assertBridgeHead } from './bridge-source-head';
import type { IBridgeSourceView, IBridgeSourceRelease } from './bridge-source.dto';
import { assetSourceMode } from './source-cache';

const object = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
/** A source check only reads metadata. Import and installer activation remain explicit administrator actions. */
@Injectable()
export class BridgeSourceService {
    private readonly repository: BridgeSourceRepository;
    private readonly checks = new Map<number, Promise<IBridgeSourceView>>();
    constructor(
        private readonly source: AssetSourcesService,
        private readonly access: AccessDb,
    ) {
        this.repository = new BridgeSourceRepository(source.pool);
    }
    async authorize(req: Request, main = false) {
        const actor = await readModelActor(req, this.access);
        if (main && actor.activeRole !== 'Главный админ')
            throw new HttpException('Изменять источник и готовить поставку моста может главный администратор.', 403);
        return actor.email;
    }
    async view(): Promise<IBridgeSourceView> {
        const settings = await this.repository.settings(),
            repository = bridgeSourceRepository(settings.url);
        const snapshot = settings.check_commit
            ? await this.repository.snapshot(repository, settings.check_commit)
            : undefined;
        let imported: IBridgeSourceRelease | undefined, importedError: string | undefined;
        try {
            const supply = await this.source.bridgeSupply();
            if (
                typeof supply.sourceCommit !== 'string' ||
                !/^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(supply.sourceCommit) ||
                supply.artifacts.some((item) => typeof item.target !== 'string')
            )
                throw new ConflictException('Текущая поставка моста содержит неполную опись.');
            const origin =
                settings.installed_repository ??
                (
                    await this.source.pool.query<{ repository: string }>(
                        "SELECT repository FROM asset_source_receipts WHERE asset_kind='bridge' AND external_id=$1 AND active ORDER BY updated_at DESC LIMIT 1",
                        [supply.assetId],
                    )
                ).rows[0]?.repository;
            imported = {
                assetId: supply.assetId,
                version: supply.version,
                buildId: supply.buildId,
                repositoryCommit: supply.sourceCommit,
                targets: supply.artifacts.map((item) => String(item.target)),
                ...(origin && origin !== 'app-bundled' ? { repositoryUrl: 'https://github.com/' + origin } : {}),
            };
        } catch (error) {
            if (settings.installed_repository || !(error instanceof HttpException) || error.getStatus() !== 404)
                importedError =
                    error instanceof HttpException ? error.message : 'Не удалось проверить текущую поставку моста.';
        }
        return {
            sourceMode: assetSourceMode(),
            url: settings.url,
            revision: settings.revision,
            ...(settings.checked_at ? { checkedAt: new Date(settings.checked_at).toISOString() } : {}),
            ...(settings.error ? { error: settings.error } : {}),
            ...(snapshot ? { available: bridgeReleaseView(snapshot) } : {}),
            ...(imported ? { imported } : {}),
            ...(importedError ? { importedError } : {}),
            ...(isRetiredBridgeSource(settings.url)
                ? { sourceReady: false, archiveRequired: true, error: retiredBridgeSourceMessage }
                : {}),
        };
    }
    async save(actor: string, body: unknown) {
        if (!object(body, ['url', 'expectedRevision']) || !revision(body.expectedRevision))
            throw new BadRequestException('Передайте адрес источника и текущую ревизию настроек.');
        await this.repository.save(actor, bridgeSourceUrl(body.url), body.expectedRevision);
        return this.view();
    }
    async check(body: unknown) {
        if (
            !object(body, ['expectedRevision', 'force']) ||
            !revision(body.expectedRevision) ||
            (body.force !== undefined && typeof body.force !== 'boolean')
        )
            throw new BadRequestException('Передайте текущую ревизию источника моста.');
        const configured = await this.repository.settings();
        if (isRetiredBridgeSource(configured.url)) {
            if (configured.revision !== body.expectedRevision) throw staleBridgeSource();
            return this.view();
        }
        if (assetSourceMode() === 'offline') {
            if ((await this.repository.settings()).revision !== body.expectedRevision) throw staleBridgeSource();
            const view = await this.view();
            if (view.revision !== body.expectedRevision) throw staleBridgeSource();
            return view;
        }
        const expected = body.expectedRevision,
            existing = this.checks.get(expected);
        if (existing) return existing;
        const operation = this.inspect(expected, body.force === true);
        this.checks.set(expected, operation);
        try {
            return await operation;
        } finally {
            if (this.checks.get(expected) === operation) this.checks.delete(expected);
        }
    }
    private async inspect(expected: number, force: boolean) {
        const { settings, token } = await this.repository.begin(expected, force);
        if (!token) return this.view();
        const abort = new AbortController(),
            timer = setTimeout(() => abort.abort(), 45000);
        try {
            const snapshot = await readBridgeSource(settings.url, abort.signal);
            await this.repository.checked(settings, token, snapshot);
            return await this.view();
        } catch (error) {
            const failure = abort.signal.aborted
                ? new ServiceUnavailableException(
                      'Проверка источника моста не завершилась за 45 секунд. Повторите позже.',
                  )
                : error;
            await this.repository.failed(
                settings,
                token,
                failure instanceof HttpException ? failure.message : 'Не удалось проверить источник поставок моста.',
            );
            if (failure instanceof HttpException) throw failure;
            throw new ServiceUnavailableException('Не удалось проверить источник поставок моста.');
        } finally {
            clearTimeout(timer);
        }
    }
    async import(actor: string, body: unknown) {
        if (
            !object(body, ['expectedRevision', 'commit', 'assetId', 'requestKey']) ||
            !revision(body.expectedRevision) ||
            typeof body.commit !== 'string' ||
            !/^[a-f0-9]{40}$/.test(body.commit) ||
            typeof body.assetId !== 'string' ||
            typeof body.requestKey !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestKey)
        )
            throw new BadRequestException('Передайте точную проверенную поставку моста и ключ запроса.');
        try {
            const previous = await this.source.jobs.byRequest(actor, body.requestKey);
            if (
                previous.bridge_source_revision !== body.expectedRevision ||
                previous.source.commit !== body.commit ||
                previous.selected_ids.length !== 1 ||
                previous.selected_ids[0] !== body.assetId
            )
                throw new ConflictException('Ключ запроса уже относится к другому импорту.');
            return importView(previous);
        } catch (error) {
            if (!(error instanceof HttpException) || error.getStatus() !== 404) throw error;
        }
        const settings = await this.repository.settings();
        if (settings.revision !== body.expectedRevision || settings.check_commit !== body.commit || settings.error)
            throw staleBridgeSource();
        if (isRetiredBridgeSource(settings.url))
            throw new ConflictException({
                code: 'BRIDGE_SOURCE_ARCHIVE_REQUIRED',
                sourceReady: false,
                archiveRequired: true,
                message: retiredBridgeSourceMessage,
            });
        const snapshot = await this.repository.snapshot(bridgeSourceRepository(settings.url), body.commit),
            bridge = snapshot?.assets.find(
                (record) => record.current && record.asset.kind === 'bridge' && record.asset.id === body.assetId,
            );
        if (!snapshot || !bridge) throw staleBridgeSource();
        await assertBridgeHead(this.source.pool, bridge.asset as BridgeAsset);
        const job = await this.source.jobs.create(
            actor,
            body.requestKey,
            snapshot.pin,
            [body.assetId],
            body.expectedRevision,
        );
        this.source.kickImports();
        return importView(job);
    }
}
