import type { BuildDiagnostic } from '../../../shared/package-build-diagnostics.cjs';
import type { ExecutableBuildPlan } from '../../../shared/package-build-plan.cjs';
import type { PoolClient } from 'pg';
import { BadRequestException } from '@nestjs/common';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import type { BuildConfiguration } from './package-build.model';
import { validateModelId } from '../models/model-validation';

export const PACKAGE_AGENT_ID = 'agent-packager';
export const PACKAGE_AGENT_MAX_ATTEMPTS = 3;
export const PACKAGE_AGENT_MAX_CALLS = 6;
export interface PackageAgentInput {
    modelId: string;
    expectedModelPin: string;
    maxAttempts: number;
}
export type AgentBuildConfiguration = BuildConfiguration & { agent?: PackageAgentInput };
export type PackageAgentStage = 'propose' | 'review';
export type PackageAgentRecipe = ExecutableBuildPlan | { schemaVersion: 2 } | { entrypoint: string; args?: string[] };
export interface PackageAgentRuntimeReport {
    build?: BuildDiagnostic;
    passed: boolean;
    summary?: string;
    diagnostics?: readonly string[];
}
export type PackageAgentReview = { decision: 'publish' } | { decision: 'repair'; config: BuildConfiguration };
export type PackageAgentDb = Pick<PoolClient, 'query'>;
export interface PackageAgentContext {
    buildId: string;
    executionNonce: string;
    actorEmail: string;
    actorRole?: string;
    attempt: number;
    signal: AbortSignal;
    /** These entrypoints have already been inspected in the original pinned source. */
    candidates: readonly string[];
    /** Trusted argument vectors; model-generated arguments are never executed. */
    argumentCandidates?: readonly (readonly string[])[];
    requiredFeatures?: readonly FeatureFlagKey[];
    feedback?: PackageAgentRuntimeReport;
    /** Freshly checks main-admin role and feature flags; called again after rate waits. */
    authorize: () => Promise<void>;
    /** Uses the existing builder lease, BEGIN/COMMIT, deadlines and taint handling. */
    transaction: <T>(work: (db: PackageAgentDb) => Promise<T>) => Promise<T>;
}

/** Agent use is explicit, bounded and pinned to a server model identity. */
export function validatePackageAgentInput(value: unknown): PackageAgentInput {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BadRequestException('Выберите модель агента «Упаковщик».');
    const raw = value as Record<string, unknown>,
        maxAttempts = raw.maxAttempts ?? PACKAGE_AGENT_MAX_ATTEMPTS;
    if (
        Object.keys(raw).some((key) => !['modelId', 'expectedModelPin', 'maxAttempts'].includes(key)) ||
        typeof raw.modelId !== 'string' ||
        typeof raw.expectedModelPin !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.expectedModelPin) ||
        !Number.isSafeInteger(maxAttempts) ||
        Number(maxAttempts) < 1 ||
        Number(maxAttempts) > PACKAGE_AGENT_MAX_ATTEMPTS
    )
        throw new BadRequestException('Нужны выбранная модель, точный pin и от 1 до 3 попыток агента «Упаковщик».');
    return {
        modelId: validateModelId(raw.modelId),
        expectedModelPin: raw.expectedModelPin,
        maxAttempts: Number(maxAttempts),
    };
}
