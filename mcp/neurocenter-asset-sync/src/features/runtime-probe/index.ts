import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verify } from '../../bridge/package.js';
import { packageDependencies, packageRef, referenceKey, verifyInstallSet } from '../../bridge/install-set.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { ProbeError, type RuntimeProbeInput, type RuntimeProbeResult } from './model.js';
import { ProbeScope } from './process.js';
import { assertNoManagedPreferences, createProfile, removeProfile, type ProbeProfile } from './profile.js';
import { checkSkill } from './skill.js';
import { probeMcp } from './mcp.js';
import { probePlugin } from './plugin.js';
import { probeConfigurations } from './configuration.js';
import { windowsJobHelper } from './windows-job.js';

export type { RuntimeProbeInput, RuntimeProbeResult, RuntimeProbeStatus, RuntimeProbeCode } from './model.js';
const active = new Set<string>();
const sameRef = (a: RuntimeProbeInput['target'], b: RuntimeProbeInput['target']): boolean =>
    a.kind === b.kind && a.id === b.id && a.version === b.version && a.manifest === b.manifest;

function validate(input: RuntimeProbeInput): void {
    const set = input.frozenSet;
    if (
        !input.projectId ||
        input.projectId.length > 500 ||
        !input.bindingId ||
        input.bindingId.length > 500 ||
        !input.target.id ||
        input.target.id.length > 500 ||
        !Number.isSafeInteger(input.target.version) ||
        input.target.version < 1 ||
        !sameRef(set.root, input.target) ||
        set.schemaVersion !== 1 ||
        !Array.isArray(set.packages)
    ) {
        throw new Error();
    }
    if (set.packages.length === 1) {
        const pkg = set.packages[0]!;
        verify(pkg);
        if (
            packageDependencies(pkg).length ||
            !sameRef(packageRef(pkg), input.target) ||
            set.manifest !== pkg.manifest.sha256
        ) {
            throw new Error();
        }
    } else {
        verifyInstallSet(set);
    }
    if (input.consentManifest !== set.manifest) {
        throw new ProbeError('not_checked', 'not-approved');
    }
    const revisions = input.configurationRevisions;
    if (
        revisions !== undefined &&
        (!Array.isArray(revisions) ||
            revisions.length > 20 ||
            revisions.some(
                (item, index) =>
                    !item ||
                    Object.keys(item).some((key) => !['assetId', 'manifest', 'revision'].includes(key)) ||
                    typeof item.assetId !== 'string' ||
                    !item.assetId ||
                    item.assetId.length > 500 ||
                    !/^[a-f0-9]{64}$/.test(item.manifest) ||
                    (item.revision !== null &&
                        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                            item.revision,
                        )) ||
                    (index > 0 && revisions[index - 1]!.assetId >= item.assetId),
            ))
    ) {
        throw new Error();
    }
}
async function current(input: RuntimeProbeInput, scope: ProbeScope): Promise<void> {
    for (const pkg of input.frozenSet.packages) {
        let result;
        try {
            result = await scope.wait(inspectInstallation(input.projectId, pkg));
            assertInspectionIdentity(result, input.projectId, input.bindingId, pkg);
        } catch (error) {
            if (error instanceof ProbeError) {
                throw error;
            }
            throw new ProbeError('stale', 'installation-not-current');
        }
        if (result.state === 'busy') {
            throw new ProbeError('busy', 'inspection-busy');
        }
        if (result.status !== 'synced') {
            throw new ProbeError('stale', 'installation-not-current');
        }
    }
}

/** Хэш проверяется для фактически исполняемой копии, включая разрешённую внешнюю ad-hoc подпись. */
async function assertEngine(input: RuntimeProbeInput, scope: ProbeScope): Promise<void> {
    if (
        input.openCode.version !== '1.14.48' ||
        !/^[a-f0-9]{64}$/.test(input.openCode.sha256) ||
        !path.isAbsolute(input.openCode.path)
    ) {
        throw new ProbeError('unsupported', 'runtime-mismatch');
    }
    let file;
    try {
        const before = await fs.lstat(input.openCode.path);
        if (!before.isFile() || before.size <= 0 || before.size > 256 * 1024 * 1024) {
            throw new Error();
        }
        file = await fs.open(input.openCode.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) {
            throw new Error();
        }
        const digest = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let bytes = 0;
        for (;;) {
            scope.remaining();
            const read = await file.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) {
                break;
            }
            bytes += read.bytesRead;
            if (bytes > opened.size) {
                throw new Error();
            }
            digest.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await file.stat();
        if (
            bytes !== opened.size ||
            opened.size !== after.size ||
            opened.mtimeMs !== after.mtimeMs ||
            opened.ctimeMs !== after.ctimeMs ||
            digest.digest('hex') !== input.openCode.sha256
        ) {
            throw new ProbeError('unsupported', 'runtime-mismatch');
        }
    } catch (error) {
        if (error instanceof ProbeError) {
            throw error;
        }
        throw new ProbeError('unsupported', 'runtime-unavailable');
    } finally {
        await file?.close();
    }
}

/** Явная диагностика уже установленного frozen набора. Не устанавливает пакеты и не изменяет рабочий проект. */
export async function runRuntimeProbe(source: RuntimeProbeInput): Promise<RuntimeProbeResult> {
    const result: RuntimeProbeResult = {
        schemaVersion: 1,
        projectId: source.projectId,
        bindingId: source.bindingId,
        assetId: source.target.id,
        assetKind: source.target.kind,
        version: source.target.version,
        manifest: source.target.manifest,
        approvalManifest: source.consentManifest,
        checkedAt: new Date().toISOString(),
        engineVersion: '1.14.48',
        engineSha256: /^[a-f0-9]{64}$/.test(source.openCode.sha256) ? source.openCode.sha256 : '',
        status: 'not_checked',
        code: 'not-approved',
        counts: { packages: 0, files: 0, skills: 0, mcp: 0, tools: 0, resources: 0, prompts: 0, pluginsInitialized: 0 },
    };
    const scope = new ProbeScope();
    let profile: ProbeProfile | undefined;
    let lease: string | undefined;
    try {
        // Callback не может незаметно изменить frozen bytes во время авторизации.
        let input: RuntimeProbeInput;
        try {
            input = { ...structuredClone({ ...source, authorize: undefined }), authorize: source.authorize };
            validate(input);
        } catch (error) {
            if (error instanceof ProbeError) {
                throw error;
            }
            throw new ProbeError('not_checked', 'invalid-package');
        }
        if (input.configurationRevisions !== undefined) {
            result.configurationRevisions = structuredClone(input.configurationRevisions);
        }
        if (process.platform === 'win32' && !(await windowsJobHelper())) {
            throw new ProbeError('unsupported', 'unsupported-platform');
        }
        const key = JSON.stringify([input.projectId, input.bindingId]);
        if (active.has(key)) {
            throw new ProbeError('busy', 'inspection-busy');
        }
        active.add(key);
        lease = key;
        await current(input, scope);
        const configuration = await probeConfigurations(input);
        await assertNoManagedPreferences();
        profile = await createProfile([], scope);
        const authorize = async (): Promise<void> => {
            await input.authorize();
            await current(input, scope);
            await assertEngine(input, scope);
            await probeConfigurations(input);
        };
        const version = await scope.command(
            input.openCode.path,
            ['--version'],
            profile.project,
            profile.env,
            authorize,
            true,
        );
        if (version.code !== 0 || version.stdout.trim() !== '1.14.48') {
            throw new ProbeError('unsupported', 'runtime-mismatch');
        }
        await removeProfile(profile);
        profile = undefined;
        const packages = [...input.frozenSet.packages].sort((a, b) => {
            const left = referenceKey(packageRef(a));
            const right = referenceKey(packageRef(b));
            return left === right ? 0 : left < right ? -1 : 1;
        });
        for (const original of packages) {
            const pkg = configuration.packages.get(referenceKey(packageRef(original))) ?? original;
            scope.remaining();
            if (pkg.plugin.kind === 'skill') {
                checkSkill(pkg);
                result.counts.skills++;
            } else {
                // Каждый исполняемый пакет получает новый HOME: предыдущий пакет не подменит следующий config.
                profile = await createProfile([pkg], scope);
                if (pkg.plugin.kind === 'mcp') {
                    const counts = await probeMcp(pkg, profile, scope, authorize);
                    result.counts.mcp++;
                    result.counts.tools += counts.tools;
                    result.counts.resources += counts.resources;
                    result.counts.prompts += counts.prompts;
                } else {
                    await probePlugin(pkg, profile, scope, input.openCode.path, authorize);
                    result.counts.pluginsInitialized++;
                }
            }
            result.counts.packages++;
            result.counts.files += pkg.files.length;
            if (profile) {
                await removeProfile(profile);
                profile = undefined;
            }
        }
        await scope.authorize(authorize);
        result.status = 'passed';
        result.code = 'verified';
    } catch (error) {
        result.status = error instanceof ProbeError ? error.status : 'failed';
        result.code = error instanceof ProbeError ? error.code : 'probe-failed';
    } finally {
        scope.close();
        if (profile) {
            try {
                await removeProfile(profile);
            } catch {
                result.status = 'failed';
                result.code = 'probe-failed';
            }
        }
        if (lease) {
            active.delete(lease);
        }
        result.checkedAt = new Date().toISOString();
    }
    return result;
}
