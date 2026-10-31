import { ConflictException } from '@nestjs/common';
import { toAgentRecord, type AgentAsset, type ResolvedAsset } from '@neurocenter/asset-contract';
import type { Pool, PoolClient } from 'pg';
import { publicationHash } from '../publication/publication-validation';
import { securityEvent } from '../access/security-events';
import { AgentRepository, agentSummary } from '../agents/agent.repository';
import { agentCard, agentManifest, agentNativeHash, normalizeCard } from '../agents/agent-validation';
import type { AgentCard, AgentHeadRow } from '../agents/agent.types';
import type { IImportItem, INativeAssetPin, ISourceReceipt } from './import-types';

/** Source provenance and immutable versions are retained independently from the editable catalog head. */
export class AgentAssetAdapter {
    private readonly cards: AgentRepository;
    constructor(private readonly pool: Pool) {
        this.cards = new AgentRepository(pool);
    }
    private candidate(item: IImportItem): AgentCard {
        const input = normalizeCard({
            slug: item.payload!.slug,
            name: item.payload!.name,
            definition: item.payload!.definition,
        });
        return {
            id: item.native!.id,
            ...input,
            description: input.definition.description,
            version: item.native!.version,
            manifest: item.native!.manifest!,
            archivedAt: null,
            createdAt: '',
            updatedAt: '',
        };
    }
    async preview(
        resolved: ResolvedAsset,
        key: string,
        planned: IImportItem[],
        receipt?: ISourceReceipt,
        versionReceipt?: ISourceReceipt,
        overrideHash?: string,
    ): Promise<IImportItem> {
        const native = toAgentRecord(resolved.asset as AgentAsset),
            id = receipt?.native_id ?? native.id,
            input = normalizeCard({ slug: native.slug, name: native.name, definition: native.definition }),
            payload = { id, ...input };
        const previous = [...planned]
            .reverse()
            .find(
                (item) =>
                    item.resolved.asset.id === resolved.asset.id &&
                    item.native &&
                    item.payload &&
                    !item.preserveHead &&
                    item.action !== 'conflict',
            );
        const saved = (await this.pool.query<AgentHeadRow>('SELECT * FROM agent_catalog WHERE id=$1', [id])).rows[0],
            row = previous ? this.candidate(previous) : saved ? agentCard(saved) : undefined;
        const base: IImportItem = {
            resolved,
            requestKey: key,
            name: input.name,
            action: 'create',
            state: 'PENDING',
            payload,
        };
        if (row?.archivedAt)
            return { ...base, action: 'conflict', reason: 'Агент находится в архиве. Сначала верните его в каталог.' };
        const approved = !!row && overrideHash === agentNativeHash(row);
        if (overrideHash && !approved)
            return {
                ...base,
                action: 'conflict',
                reason: 'Агент изменился после подтверждения замены. Проверьте конфликт заново.',
            };
        if (
            receipt &&
            resolved.current &&
            !previous &&
            !approved &&
            (!row || agentNativeHash(row) !== receipt.native_hash)
        )
            return {
                ...base,
                action: 'conflict',
                expected: row ? this.pin(row) : undefined,
                replaceable: !!row,
                reason: 'Агент изменён локально. Явная замена источником сохранит закреплённые версии и настройки проектов.',
            };
        if (versionReceipt && !approved) {
            if (versionReceipt.descriptor_sha256 !== resolved.sha256 || !row || versionReceipt.native_id !== id)
                return {
                    ...base,
                    action: 'conflict',
                    reason: 'Версия источника связана с другим неизменяемым агентом.',
                };
            const old = (
                await this.pool.query<AgentHeadRow>(
                    'SELECT agent_id AS id,slug,name,definition,version,manifest,NULL::timestamptz AS archived_at,created_at,created_at AS updated_at FROM agent_catalog_versions WHERE agent_id=$1 AND version=$2',
                    [id, versionReceipt.native_version],
                )
            ).rows[0];
            if (!old || agentNativeHash(agentCard(old)) !== versionReceipt.native_hash)
                return { ...base, action: 'conflict', reason: 'Исторический агент не совпадает с квитанцией.' };
            return { ...base, action: 'unchanged', preserveHead: true, native: this.pin(agentCard(old)) };
        }
        const same =
            row &&
            publicationHash({ slug: row.slug, name: row.name, definition: row.definition }) === publicationHash(input);
        if (row && !receipt && !previous && !same && !approved)
            return {
                ...base,
                action: 'conflict',
                expected: this.pin(row),
                replaceable: resolved.current,
                reason: 'ID агента занят локальной карточкой. Требуется явная замена.',
            };
        const slugOwner = (
            await this.pool.query<{ id: string }>('SELECT id FROM agent_catalog WHERE slug=$1 AND id<>$2', [
                input.slug,
                id,
            ])
        ).rows[0];
        if (
            slugOwner ||
            planned.some(
                (item) => item.native?.kind === 'agent' && item.native.id !== id && item.payload?.slug === input.slug,
            )
        )
            return {
                ...base,
                action: 'conflict',
                replaceable: false,
                reason: 'Имя OpenCode уже занято другим агентом.',
            };
        const maximum = Number(
            (
                await this.pool.query<{ v: number }>(
                    'SELECT coalesce(max(version),0) AS v FROM agent_catalog_versions WHERE agent_id=$1',
                    [id],
                )
            ).rows[0]?.v ?? 0,
        );
        const plannedMaximum = Math.max(
            maximum,
            ...planned
                .filter((item) => item.native?.id === id && item.native.kind === 'agent')
                .map((item) => item.native!.version),
        );
        const version = row ? (same ? row.version : Math.max(row.version, plannedMaximum) + 1) : 1,
            snapshot = !!row && !resolved.current && !same;
        const manifest = agentManifest({ id, ...input, version }),
            candidate: AgentCard = {
                id,
                ...input,
                description: input.definition.description,
                version,
                manifest,
                archivedAt: null,
                createdAt: '',
                updatedAt: '',
            };
        return {
            ...base,
            action: row ? (same ? 'unchanged' : snapshot ? 'snapshot' : 'update') : 'create',
            preserveHead: snapshot,
            replacesLocal: approved,
            expected: row ? this.pin(row) : undefined,
            native: this.pin(candidate),
        };
    }
    async publish(item: IImportItem, actor: string, db: PoolClient): Promise<INativeAssetPin> {
        if (!item.payload || !item.native || item.action === 'conflict')
            throw new ConflictException('План не разрешает публикацию агента.');
        const id = item.native.id,
            input = normalizeCard({
                slug: item.payload!.slug,
                name: item.payload!.name,
                definition: item.payload!.definition,
            }),
            saved = (await db.query<AgentHeadRow>('SELECT * FROM agent_catalog WHERE id=$1 FOR UPDATE', [id])).rows[0],
            row = saved ? agentCard(saved) : undefined;
        if (item.action === 'unchanged' && item.preserveHead) {
            const old = await this.cards.pinned(id, item.native.version, item.native.manifest!, db);
            if (this.pin(old).hash !== item.native.hash) throw new ConflictException('Исторический агент изменился.');
            return this.pin(old);
        }
        if (item.expected ? !row || this.pin(row).hash !== item.expected.hash : !!row)
            throw new ConflictException('Агент изменился после предварительного просмотра.');
        if (item.action === 'unchanged') return this.pin(row!);
        const maximum = Number(
            (
                await db.query<{ v: number }>(
                    'SELECT coalesce(max(version),0) AS v FROM agent_catalog_versions WHERE agent_id=$1',
                    [id],
                )
            ).rows[0].v,
        );
        if (maximum + 1 !== item.native.version)
            throw new ConflictException('История агента изменилась после предварительного просмотра.');
        const card = await this.cards.write(db, id, input, item.native.version, {
            snapshot: item.action === 'snapshot',
        });
        await securityEvent(db, {
            actor,
            action: item.action === 'snapshot' ? 'agent.snapshot' : 'agent.import',
            resourceId: id,
            before: row ? agentSummary(row) : null,
            after: agentSummary(card),
        });
        return this.pin(card);
    }
    pin(card: AgentCard): INativeAssetPin {
        return {
            kind: 'agent',
            id: card.id,
            version: card.version,
            manifest: card.manifest,
            hash: agentNativeHash(card),
        };
    }
}
