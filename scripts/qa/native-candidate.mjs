import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {artifactTree, regularBytes, exclusion} from '../workspace/isolated-build-source.mjs';
import {readQaFile, sha256, isRunId, canonicalQaRoot, QaPostgresError} from './postgres-contract.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sourceScope = name => name.startsWith('services/catalog-service/') || name.startsWith('services/shared/');
const requiredSources = ['services/catalog-service/src/package-build/package-build.service.ts',
    'services/catalog-service/src/publication/plugin-repository.ts', 'services/catalog-service/src/asset-sources/local-skill-ingest.ts'];
const compiledFiles = ['package-build/package-build.service.js', 'publication/plugin-repository.js', 'asset-sources/local-skill-ingest.js'];
const fail = () => new QaPostgresError('QA_CANDIDATE_INVALID');

async function currentSourceNames(root, records) {
    const names = execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'services/catalog-service', 'services/shared'],
    {cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 ** 2,
        env: {PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'}}).split('\0').filter(Boolean);
    const present = [];
    for (const name of new Set(names)) {
        if (!sourceScope(name) || exclusion(name)) continue;
        if (records[name]?.state === 'deleted') {
            try { await fs.lstat(path.join(root, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        }
        present.push(name);
    }
    return present.sort();
}

async function json(filename) {
    try { return JSON.parse((await readQaFile(filename, {privateMode: true, maximumBytes: 8 * 1024 ** 2})).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw fail(); throw error; }
}

/** Verify retained source and artifact bytes; matching HEAD alone never admits a candidate. */
export async function readNativeCandidate(root, filename) {
    await canonicalQaRoot(root);
    if (!path.isAbsolute(filename ?? '') || path.resolve(filename) !== filename) throw fail();
    const directory = path.dirname(filename), runId = path.basename(directory), repository = path.join(directory, 'repository');
    if (!isRunId(runId) || filename !== path.join(root, '.run/isolated-build', runId, 'receipt.json')) throw fail();
    const receiptBytes = await readQaFile(filename, {privateMode: true, maximumBytes: 8 * 1024 ** 2});
    let receipt;
    try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch { throw fail(); }
    if (receipt?.schemaVersion !== 1 || receipt.id !== runId || receipt.ok !== true || receipt.status !== 'built-current-snapshot'
        || receipt.repository !== repository || receipt.sourceCurrent !== true || receipt.candidateInputsUnchanged !== true
        || receipt.liveOutputsUnchanged !== true || receipt.dependencyLinksUnchanged !== true
        || !Array.isArray(receipt.selectedPackages) || !receipt.selectedPackages.includes('catalog-service')
        || !Array.isArray(receipt.builds) || !digest(receipt.inputs?.sha256)) throw fail();
    const builds = receipt.builds.filter(item => item?.id === 'catalog-service');
    if (builds.length !== 1 || builds[0].ok !== true || builds[0].exitCode !== 0 || builds[0].signal !== null
        || builds[0].leaderReaped !== true || builds[0].cleanup?.noLiveDescendants !== true
        || builds[0].artifacts?.requiredEntry !== 'main.js' || builds[0].artifacts.requiredEntryPresent !== true) throw fail();
    const snapshot = await json(path.join(directory, 'source-copied.json'));
    if (!object(snapshot?.records) || Object.keys(snapshot.records).length > 20000
        || snapshot.digest !== receipt.inputs.sha256 || sha256(Buffer.from(JSON.stringify(snapshot.records))) !== snapshot.digest) throw fail();
    const hashes = {};
    for (const [name, entry] of Object.entries(snapshot.records)) {
        if (!sourceScope(name) || entry?.state !== 'present') continue;
        if (!digest(entry.sha256)) throw fail();
        const retained = await regularBytes(repository, name), current = await regularBytes(root, name);
        if (sha256(retained.bytes) !== entry.sha256 || sha256(current.bytes) !== entry.sha256)
            throw new QaPostgresError('QA_CANDIDATE_SOURCE_CHANGED');
        hashes[name] = entry.sha256;
    }
    if (requiredSources.some(name => !Object.hasOwn(hashes, name))) throw fail();
    if (JSON.stringify(await currentSourceNames(root, snapshot.records)) !== JSON.stringify(Object.keys(hashes).sort()))
        throw new QaPostgresError('QA_CANDIDATE_SOURCE_CHANGED');
    const recorded = await json(path.join(directory, 'catalog-service-artifacts.json'));
    if (!recorded?.exists || !object(recorded.files) || !Object.keys(recorded.files).length
        || Object.values(recorded.files).some(value => !digest(value))
        || recorded.digest !== builds[0].artifacts.sha256) throw fail();
    const artifacts = await artifactTree(path.join(repository, 'services/catalog-service/dist'));
    if (artifacts.digest !== recorded.digest || artifacts.bytes !== recorded.bytes || !Object.hasOwn(artifacts.files, 'main.js')
        || compiledFiles.some(name => !Object.hasOwn(artifacts.files, name)))
        throw new QaPostgresError('QA_CANDIDATE_ARTIFACT_CHANGED');
    const fingerprint = sha256(Buffer.from(JSON.stringify({receipt: sha256(receiptBytes), source: hashes, artifacts: artifacts.digest})));
    return {receipt: filename, repository, fingerprint, artifactDigest: artifacts.digest,
        compiledHashes: Object.fromEntries(compiledFiles.map(name => [name, artifacts.files[name]])),
        sourceReceipt: {sourceFiles: Object.keys(hashes), hashes},
        limits: ['Only Catalog/shared source bytes are matched to the selected checkout.',
            'Existing candidate dependencies remain linked; their contents are not frozen or authenticated.']};
}

export const nativeHarnessFiles = ['scripts/qa/native.mjs', 'scripts/qa/native-candidate.mjs',
    'scripts/qa/postgres-contract.mjs', 'scripts/qa/postgres-process.mjs', 'scripts/qa/postgres-runtime.mjs', 'scripts/qa/postgres-admission.mjs',
    'scripts/test/native/package-publication-rollback.test.mjs', 'scripts/test/package-publication-rollback.fixture.mjs',
    'scripts/test/owned-postgres.fixture.mjs', 'scripts/workspace/isolated-build-process.mjs', 'scripts/workspace/isolated-build-source.mjs'];

/** Bind the selected harness and admission implementation to before/after observations. */
export async function nativeHarnessHashes(root) {
    const hashes = {};
    for (const name of nativeHarnessFiles) hashes[name] = sha256((await regularBytes(root, name, 1024 ** 2)).bytes);
    return hashes;
}
