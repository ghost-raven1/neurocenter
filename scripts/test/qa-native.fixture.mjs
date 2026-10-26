import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {artifactTree} from '../workspace/isolated-build-source.mjs';
import {sha256, saveQaJson} from '../qa/postgres-contract.mjs';
import {nativeHarnessFiles} from '../qa/native-candidate.mjs';

/** Build only tiny source/artifact receipts, never compile or connect to PostgreSQL. */
export async function nativeCandidateFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc native QA candidate ')));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const sources = {'services/catalog-service/src/package-build/package-build.service.ts': 'export const build = 1;\n',
        'services/catalog-service/src/publication/plugin-repository.ts': 'export const publication = 1;\n',
        'services/catalog-service/src/asset-sources/local-skill-ingest.ts': 'export const skill = 1;\n',
        'services/catalog-service/package.json': '{"name":"catalog-fixture"}\n', 'services/shared/runtime.cjs': 'module.exports = {};\n'};
    const put = async (base, name, value) => { const file = path.join(base, name); await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700}); await fs.writeFile(file, value, {mode: 0o600}); };
    await put(root, 'package.json', '{"name":"neurocenter-workspace"}\n'); await put(root, '.gitignore', '.run/\n');
    for (const [name, value] of Object.entries(sources)) await put(root, name, value);
    for (const name of nativeHarnessFiles) await put(root, name, '// Private harness fingerprint fixture.\n');
    const git = args => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {cwd: root,
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}, encoding: 'utf8'});
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Native fixture']);
    const id = randomUUID(), directory = path.join(root, '.run/isolated-build', id), repository = path.join(directory, 'repository');
    const records = {};
    for (const [name, value] of Object.entries(sources)) { await put(repository, name, value); records[name] = {state: 'present', tracked: true, sha256: sha256(Buffer.from(value)), bytes: Buffer.byteLength(value), executable: false}; }
    for (const name of ['main.js', 'publication/plugin-repository.js', 'package-build/package-build.service.js', 'asset-sources/local-skill-ingest.js'])
        await put(repository, 'services/catalog-service/dist/' + name, 'module.exports = {};\n');
    const artifacts = await artifactTree(path.join(repository, 'services/catalog-service/dist')), digest = sha256(Buffer.from(JSON.stringify(records)));
    await saveQaJson(path.join(directory, 'source-copied.json'), {records, digest});
    await saveQaJson(path.join(directory, 'catalog-service-artifacts.json'), artifacts);
    const receipt = path.join(directory, 'receipt.json'), value = {schemaVersion: 1, id, ok: true, status: 'built-current-snapshot',
        selectedPackages: ['catalog-service'], repository, sourceCurrent: true, candidateInputsUnchanged: true,
        liveOutputsUnchanged: true, dependencyLinksUnchanged: true, inputs: {sha256: digest},
        builds: [{id: 'catalog-service', ok: true, exitCode: 0, signal: null, leaderReaped: true, cleanup: {noLiveDescendants: true},
            artifacts: {sha256: artifacts.digest, requiredEntry: 'main.js', requiredEntryPresent: true}}]};
    await saveQaJson(receipt, value);
    const runId = randomUUID(), cluster = path.join(root, '.run/qa-postgres', runId); await fs.mkdir(cluster, {recursive: true, mode: 0o700});
    const options = {action: 'run', runId, scenario: 'publication-rollback', candidate: receipt};
    return {root, directory, repository, cluster, receipt, value, records, sources, options, put, owner: {nonce: randomUUID(), runDirectory: cluster},
        save: () => saveQaJson(receipt, value)};
}

export async function successfulNativeReceipt({env, owner}) {
    const names = ['primary error identity retained', 'observer sees no failed publication before unrelated COMMIT',
        'observer sees no failed publication after unrelated COMMIT', 'normal rollback reuses PID; unknown rollback discards it',
        'release destroys unknown rollback session'];
    const candidate = env.PACKAGE_PUBLICATION_ROLLBACK_CANDIDATE, sourceReceiptFile = env.PACKAGE_PUBLICATION_ROLLBACK_SOURCE_RECEIPT;
    const sourceBytes = await fs.readFile(sourceReceiptFile), source = JSON.parse(sourceBytes.toString('utf8'));
    const artifacts = JSON.parse(await fs.readFile(path.join(candidate, '../catalog-service-artifacts.json'), 'utf8'));
    const compiledHashes = Object.fromEntries(['package-build/package-build.service.js', 'publication/plugin-repository.js',
        'asset-sources/local-skill-ingest.js'].map(name => [name, artifacts.files[name]]));
    return {schemaVersion: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ownerNonce: owner.nonce,
        candidate, sourceReceiptFile, sourceReceiptSha256: sha256(sourceBytes), sourceHashes: source.hashes,
        liveSourceHashes: {...source.hashes}, liveSourceDrift: [], compiledHashes,
        status: 'GREEN', ownDatabaseDropped: true, originalDatabasesPreserved: true, cleanupErrors: [], harnessFailures: [], causalFailures: [],
        cases: ['normal', 'not-dispatched'].map(rollback => ({owner: 'PluginRepository', rollback, invariants: names.map(name => ({name, passed: true}))}))};
}

export const completedProcess = () => ({ok: true, exitCode: 0, signal: null, durationMs: 1, leaderReaped: true, cleanup: {noLiveDescendants: true}});
