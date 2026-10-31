import { BadRequestException, ConflictException } from '@nestjs/common';
import { isPreparedCodexRepository } from '../../../shared/codex-connector-source.cjs';
import { requiredAssetFeatures } from '../../../shared/feature-policy.cjs';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { IAiPluginCreate } from '../catalog/dto';
import type { BuildConfiguration } from './package-build.model';
import type { Pool } from 'pg';

/** Publication provenance is a successful server build of this exact immutable repository, never a client label. */
export async function publishedCodexConnectors(
    pool: Pool,
    pin: { sourceCommit: string; version: string; sdkVersion: string; repository: string },
) {
    return (
        await pool.query<{ id: string; version: number }>(
            `SELECT DISTINCT plugin.id,plugin.version FROM ai_plugins plugin
        JOIN tool_build_jobs build ON build.result->>'catalogId'=plugin.id AND build.result->>'version'=plugin.version::text
        WHERE plugin.kind='plugin' AND build.state='SUCCEEDED' AND build.config->>'kind'='plugin'
        AND build.config#>>'{source,type}'='repository' AND build.config#>>'{source,url}'=$4 AND build.config#>>'{source,commit}'=$1
        AND build.config#>>'{source,subdirectory}'='packages/bridge' AND build.config#>>'{source,entrypoint}'='src/plugin.ts'
        AND plugin.config#>>'{extra,codexConnector,sourceCommit}'=$1 AND plugin.config#>>'{extra,codexConnector,version}'=$2
        AND plugin.config#>>'{extra,codexConnector,sdkVersion}'=$3 AND plugin.config#>>'{extra,codexConnector,authOnly}'='true'`,
            [pin.sourceCommit, pin.version, pin.sdkVersion, pin.repository],
        )
    ).rows;
}

/** The immutable repository layout alone selects this adapter; arbitrary extra metadata grants no capability. */
export function buildFeatures(config: {
    kind: BuildConfiguration['kind'];
    source: unknown;
    agent?: unknown;
    recipeVersion?: number;
}): FeatureFlagKey[] {
    return [
        'tool_builds',
        ...requiredAssetFeatures(config.kind),
        ...(config.kind === 'skill' ? [] : ['tool_build_validation' as const]),
        ...((config.source as { type?: string })?.type === 'bundled' ? ['asset_sources' as const] : []),
        ...(config.agent ? ['tool_build_agent' as const] : []),
        ...(config.recipeVersion === 2 ? ['tool_build_agent_recipes' as const] : []),
        ...(isPreparedCodexRepository(config.source) ? ['codex_connector' as const] : []),
    ];
}
export function assertCodexBuildKind(config: Pick<BuildConfiguration, 'kind' | 'source'>): void {
    if (isPreparedCodexRepository(config.source) && config.kind !== 'plugin')
        throw new BadRequestException('Коннектор Codex устанавливается как плагин провайдера моделей.');
}
/** Publication validates the built package against trusted source pins before importing any runtime bytes. */
export function assertCodexBuildPublication(
    config: Pick<BuildConfiguration, 'kind' | 'source'>,
    publication: IAiPluginCreate,
): void {
    const metadata = publication.config?.extra?.codexConnector as Record<string, unknown> | undefined;
    if (!isPreparedCodexRepository(config.source)) {
        if (metadata !== undefined)
            throw new ConflictException('Произвольная сборка не может объявлять закреплённый коннектор Codex.');
        return;
    }
    const pin = require('../../../shared/codex-connector-pin.json') as {
        sourceCommit: string;
        version: string;
        sdkVersion: string;
    };
    assertCodexBuildKind(config);
    if (
        publication.kind !== 'plugin' ||
        !metadata ||
        Object.keys(metadata).sort().join(',') !== 'authOnly,schemaVersion,sdkVersion,sourceCommit,version' ||
        metadata.schemaVersion !== 1 ||
        metadata.authOnly !== true ||
        metadata.sourceCommit !== pin.sourceCommit ||
        metadata.version !== pin.version ||
        metadata.sdkVersion !== pin.sdkVersion ||
        !Array.isArray(publication.config?.extra?.runtimeArtifacts) ||
        !publication.config.extra.runtimeArtifacts.length
    )
        throw new ConflictException('Сборщик не подтвердил закреплённый auth-only коннектор Codex.');
}
