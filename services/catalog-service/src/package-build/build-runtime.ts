import { ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { builderScript } from './build-process';

export interface BuildRuntimeReport {
    schemaVersion: 1;
    ok: boolean;
    status: 'passed' | 'failed' | 'cancelled';
    candidate: {
        identity: string | null;
        sourceDigest: string | null;
        assetId: string | null;
        version: string | number | null;
        manifestSha256: string | null;
    };
    hostTarget: string;
    testedTarget: string | null;
    untestedTargets: string[];
    isolation: {
        kind: string;
        osEnforced: boolean;
        network: 'denied';
        childProcesses: string;
        disposableProfile: boolean;
    };
    checks: { integrity: boolean; initialize: boolean; toolsList: boolean; pluginFactory: boolean; hooks: boolean };
    counts: { tools: number; pluginHooks: number };
    diagnostics: Array<{ code: string; message: string }>;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
}

/** Only immutable manifest bytes verified by this invocation can authorize publication. */
export async function assertRuntimeCandidate(
    manifest: string,
    report: BuildRuntimeReport,
    identity: string,
): Promise<void> {
    if (
        !report.ok ||
        report.status !== 'passed' ||
        report.candidate.identity !== identity ||
        !report.checks.integrity ||
        !report.isolation.osEnforced ||
        !report.testedTarget ||
        report.isolation.network !== 'denied'
    )
        throw new ConflictException('Проверка запуска не разрешила публикацию этого кандидата.');
    const handle = await fs.open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 16 * 1024 ** 2)
            throw new Error();
        const bytes = await handle.readFile(),
            after = await handle.stat();
        if (
            before.ino !== after.ino ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== bytes.length ||
            createHash('sha256').update(bytes).digest('hex') !== report.candidate.manifestSha256
        )
            throw new Error();
    } catch {
        throw new ConflictException('Кандидат изменился после проверки запуска. Пересоберите пакет.');
    } finally {
        await handle.close();
    }
}

/** Common verifier executes package bytes only inside an enforced disposable OS sandbox. */
export async function verifyBuildRuntime(
    manifest: string,
    identity: string,
    signal: AbortSignal,
): Promise<BuildRuntimeReport> {
    signal.throwIfAborted();
    const { verifyBuiltRuntime } = createRequire(__filename)(
        path.join(path.dirname(builderScript()), 'verify-runtime.mjs'),
    ) as {
        verifyBuiltRuntime: (
            file: string,
            options: { candidateIdentity: string; signal: AbortSignal },
        ) => Promise<BuildRuntimeReport>;
    };
    const report = await verifyBuiltRuntime(manifest, { candidateIdentity: identity, signal });
    if (report.schemaVersion !== 1 || Buffer.byteLength(JSON.stringify(report)) > 65536)
        throw new Error('Некорректный результат проверки запуска.');
    return report;
}
