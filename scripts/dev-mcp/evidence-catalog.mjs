import {lstat, opendir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DiagnosticError, packages} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';

export const evidenceFamilies = ['check', 'coverage', 'isolated-build'];
export const evidenceRejectReasons = ['MALFORMED_REPORT', 'UNSAFE_REPORT', 'REPORT_CHANGED', 'REPORT_UNAVAILABLE', 'REPORT_TOO_LARGE'];
export const evidenceScanLimit = 128;
const filenames = {check: 'report.json', coverage: 'manifest.json', 'isolated-build': 'receipt.json'};
const packageIds = new Set(packages.map(([id]) => id));
const statuses = {check: ['requested-steps-complete', 'failed', 'cancelled', 'incomplete', 'in-progress'],
    coverage: ['requested-suites-complete', 'failed', 'cancelled', 'incomplete', 'in-progress'],
    'isolated-build': ['built-snapshot', 'failed', 'cancelled', 'in-progress']};
const unsafe = () => new DiagnosticError('UNSAFE_FILE', 'Evidence paths must be ordinary files and directories inside this checkout.');
const changed = () => new DiagnosticError('EVIDENCE_CHANGED', 'Evidence paths changed during the observation.');
const cancelled = (signal, error) => {
    if (signal?.aborted || error?.code === 'CANCELLED') throw new DiagnosticError('CANCELLED', 'Evidence catalog observation was cancelled.');
};
export const evidenceDigest = text => createHash('sha256').update(text).digest('hex');
export const evidenceDigestValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Fixed one-level report paths never accept caller directories, arbitrary JSON or nested runs. */
export function evidenceLocation(report) {
    const match = typeof report === 'string' && report.length <= 180
        && /^\.run\/(check|coverage|isolated-build)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(report|manifest|receipt)\.json$/.exec(report);
    if (!match || filenames[match[1]] !== match[3] + '.json') throw new DiagnosticError('INVALID_ARGUMENT', 'Select one canonical check, coverage or isolated-build report.');
    return {family: match[1], run: match[2], report, directory: path.posix.dirname(report)};
}

/** Keep inode identities across summary/capture calls as well as the FD checks inside each file read. */
export async function captureEvidencePath(root, relative, {directory = false, signal} = {}) {
    cancelled(signal);
    if (path.resolve(root) !== root || await realpath(root) !== root || path.isAbsolute(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw unsafe();
    cancelled(signal);
    const proof = [];
    let current = root;
    const parts = relative.split('/');
    for (const [index, component] of ['', ...parts].entries()) {
        cancelled(signal);
        if (component) current = path.join(current, component);
        const info = await lstat(current), isDirectory = index < parts.length || directory;
        cancelled(signal);
        if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw unsafe();
        proof.push({filename: current, directory: isDirectory, info});
    }
    return proof;
}

export async function assertEvidencePath(proof, {directoryTimes = false, signal} = {}) {
    cancelled(signal);
    if (await realpath(proof[0].filename) !== proof[0].filename) throw unsafe();
    cancelled(signal);
    for (const [index, saved] of proof.entries()) {
        cancelled(signal);
        const info = await lstat(saved.filename);
        cancelled(signal);
        if (info.isSymbolicLink() || (saved.directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw unsafe();
        if (info.dev !== saved.info.dev || info.ino !== saved.info.ino
            || directoryTimes && index === proof.length - 1 && (info.mtimeMs !== saved.info.mtimeMs || info.ctimeMs !== saved.info.ctimeMs)) throw changed();
    }
}

export function evidenceRejection(error) {
    if (error?.code === 'MALFORMED_REPORT' || error instanceof SyntaxError) return 'MALFORMED_REPORT';
    if (error?.code === 'UNSAFE_FILE' || error?.code === 'ELOOP') return 'UNSAFE_REPORT';
    if (['FILE_CHANGED', 'EVIDENCE_CHANGED'].includes(error?.code)) return 'REPORT_CHANGED';
    if (error?.code === 'FILE_TOO_LARGE') return 'REPORT_TOO_LARGE';
    return 'REPORT_UNAVAILABLE';
}

export async function readEvidenceFile(root, report, {signal} = {}) {
    cancelled(signal);
    const location = evidenceLocation(report), limit = location.family === 'coverage' ? 16 * 1024 ** 2 : 1024 ** 2;
    const file = await readOwnedFile(root, report, {limit});
    cancelled(signal);
    if (!evidenceDigestValid(file.contentSha256)) throw unsafe();
    return {...file, sha256: file.contentSha256};
}

const date = value => value === null ? null : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const malformed = () => new DiagnosticError('MALFORMED_REPORT', 'The selected evidence summary is incomplete or inconsistent.');

/** Only fixed scope fields leave the validated summary; logs, commands, private paths and arbitrary text do not. */
function scopeSummary(summary, family) {
    let selected, steps, tooling = null;
    if (family === 'check') { selected = summary.requested?.packages ?? []; steps = summary.requested?.steps ?? []; tooling = summary.requested ? summary.requested.tooling === true : null; }
    else if (family === 'coverage') { selected = summary.packages?.map(item => item.name) ?? []; steps = ['test']; }
    else { selected = summary.requestedPackages ?? []; steps = ['build']; }
    if (!Array.isArray(selected) || selected.some(id => !packageIds.has(id)) || selected.length > 32
        || !Array.isArray(steps) || steps.length > 5 || steps.some(step => !['lint', 'format:check', 'typecheck', 'build', 'test'].includes(step))) throw malformed();
    const profile = family === 'coverage' ? summary.profile : null;
    if (profile !== null && (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,119}$/.test(profile))) throw malformed();
    return {kind: family === 'isolated-build' ? 'build' : family, packages: [...new Set(selected)], steps: [...new Set(steps)],
        tooling, profile, reportedOnly: true};
}

async function catalogEntry(root, family, report, readSummary, signal) {
    try {
        cancelled(signal);
        const proof = await captureEvidencePath(root, report, {signal});
        cancelled(signal);
        const summary = await readSummary(report);
        cancelled(signal);
        const current = await readEvidenceFile(root, report, {signal});
        cancelled(signal);
        await assertEvidencePath(proof, {signal});
        cancelled(signal);
        if (!summary || summary.report !== report || !evidenceDigestValid(summary.reportSha256)
            || !statuses[family].includes(summary.status) || typeof summary.complete !== 'boolean'
            || date(summary.startedAt) === undefined || date(summary.finishedAt) === undefined) throw malformed();
        if (summary.reportSha256 !== current.sha256) throw changed();
        return {family, report, state: 'available', reportSha256: summary.reportSha256, status: summary.status, complete: summary.complete,
            countScope: scopeSummary(summary, family), startedAt: date(summary.startedAt), finishedAt: date(summary.finishedAt)};
    } catch (error) { cancelled(signal, error); return {family, report, state: 'rejected', reason: evidenceRejection(error)}; }
}

/** Enumerate a bounded, non-recursive filesystem observation; this order never implies newest or latest. */
export async function listEvidence(root, options = {}, {readSummary, signal} = {}) {
    if (!options || Object.keys(options).some(key => !['families', 'limit'].includes(key)) || typeof readSummary !== 'function')
        throw new DiagnosticError('INVALID_ARGUMENT', 'Provide evidence families and a bounded entry limit.');
    const selected = options.families ?? evidenceFamilies, limit = options.limit ?? 10;
    if (!Array.isArray(selected) || !selected.length || selected.length > 3 || new Set(selected).size !== selected.length
        || selected.some(family => !evidenceFamilies.includes(family)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new DiagnosticError('INVALID_ARGUMENT', 'Choose known evidence families and a limit from 1 to 20.');
    cancelled(signal);
    const entries = [], scan = {entryLimit: limit, scanLimit: evidenceScanLimit, scannedDirectories: 0, scannedEntries: 0,
        attemptedReports: 0, truncated: false, complete: true, rejectedFamilies: []};
    for (const family of evidenceFamilies.filter(value => selected.includes(value))) {
        cancelled(signal);
        if (entries.length >= limit || scan.scannedEntries >= evidenceScanLimit) { scan.truncated = true; break; }
        let handle, familyProof, local = [];
        try {
            familyProof = await captureEvidencePath(root, '.run/' + family, {directory: true, signal});
            cancelled(signal);
            handle = await opendir(path.join(root, '.run', family), {bufferSize: 1});
            cancelled(signal);
            scan.scannedDirectories++;
            while (true) {
                cancelled(signal);
                if (entries.length + local.length >= limit || scan.scannedEntries >= evidenceScanLimit) { scan.truncated = true; break; }
                const item = await handle.read();
                cancelled(signal);
                if (!item) break;
                scan.scannedEntries++;
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name) || !item.isDirectory() && !item.isSymbolicLink()) continue;
                const report = '.run/' + family + '/' + item.name + '/' + filenames[family];
                scan.attemptedReports++; scan.scannedDirectories++;
                local.push(await catalogEntry(root, family, report, readSummary, signal));
                cancelled(signal);
            }
            await assertEvidencePath(familyProof, {directoryTimes: true, signal});
            cancelled(signal);
        } catch (error) {
            cancelled(signal, error);
            if (error.code !== 'ENOENT' || familyProof) {
                const reason = evidenceRejection(error);
                scan.rejectedFamilies.push({family, reason}); scan.complete = false;
                local = local.map(item => ({family, report: item.report, state: 'rejected', reason}));
            }
        } finally { if (handle) await handle.close().catch(() => {}); }
        cancelled(signal);
        entries.push(...local);
    }
    cancelled(signal);
    scan.complete &&= !scan.truncated;
    return {evidence: 'recorded-local-evidence', observedAt: new Date().toISOString(), entries, scan};
}
