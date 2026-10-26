import path from 'node:path';
import {DiagnosticError} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';
import {captureCheckSource} from '../workspace/check-source.mjs';
import {bounds, sourceSnapshot, sameSource, exclusion} from '../workspace/isolated-build-source.mjs';
import {evidenceLocation, evidenceDigest, evidenceDigestValid, evidenceRejection, captureEvidencePath,
    assertEvidencePath, readEvidenceFile} from './evidence-catalog.mjs';

export const sourceComparisonReasons = ['SOURCE_MATCH', 'SOURCE_MISMATCH', 'MALFORMED_REPORT', 'UNSAFE_REPORT', 'REPORT_CHANGED',
    'REPORT_UNAVAILABLE', 'REPORT_TOO_LARGE', 'UNSUPPORTED_SOURCE_PROTOCOL', 'RECORDED_SOURCE_UNAVAILABLE',
    'RETAINED_SOURCE_UNAVAILABLE', 'RETAINED_SOURCE_INVALID', 'RETAINED_SOURCE_CHANGED',
    'CURRENT_SOURCE_UNAVAILABLE', 'CURRENT_SOURCE_LIMIT', 'CURRENT_SOURCE_UNSAFE', 'CURRENT_SOURCE_CHANGED', 'CANCELLED'];
export const sourceComparisonScopes = ['check-v3-recorded-after', 'isolated-build-source-snapshot', 'unsupported-source-protocol'];
const metadataLimit = 16 * 1024 ** 2;
const compactKeys = ['head', 'sha256', 'files', 'bytes', 'newFiles', 'deleted', 'exclusions'];
const limits = [
    'Source identity includes retained paths, tracked/new/deleted state, executable bits and HEAD; a mismatch is not necessarily a source-byte edit.',
    'Generated outputs, active private configuration, excluded file contents, dependencies, built artifacts and currently loaded runtime are outside this comparison.',
    'Local reports and retained metadata are not authenticated. Bounded before/after observations cannot rule out an intermediate edit followed by restoration.',
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const head = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const compact = snapshot => ({head: snapshot.head, sha256: snapshot.digest, files: snapshot.files, bytes: snapshot.bytes,
    newFiles: snapshot.newFiles, deleted: snapshot.deleted, exclusions: Object.keys(snapshot.excluded).length});
const sameCompact = (left, right) => compactKeys.every(key => left[key] === right[key]);
const invalidMetadata = () => new DiagnosticError('RETAINED_SOURCE_INVALID', 'Retained source metadata cannot establish its declared scope.');

function sourcePath(name) {
    return typeof name === 'string' && name.length <= 1024 && !path.posix.isAbsolute(name) && !/[\\\x00-\x1f\x7f]/.test(name)
        && name.split('/').every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}

/** Retained hashes must reproduce the receipt's aggregate and the exact supported snapshot protocol. */
function retainedSnapshot(value, inputs) {
    if (!object(value) || !head(value.head) || !evidenceDigestValid(value.digest) || !object(value.records) || !object(value.excluded)
        || !inputs || ['files', 'bytes', 'newFiles', 'deleted'].some(key => !count(value[key]))) throw invalidMetadata();
    const names = Object.keys(value.records), excluded = Object.entries(value.excluded), folded = new Set();
    if (names.length + excluded.length > bounds.files) throw invalidMetadata();
    let files = 0, deleted = 0, bytes = 0, newFiles = 0;
    for (const name of names) {
        if (!sourcePath(name) || exclusion(name)) throw invalidMetadata();
        const normal = name.normalize('NFC').toLowerCase();
        if (folded.has(normal)) throw invalidMetadata(); folded.add(normal);
        const record = value.records[name];
        if (!object(record) || typeof record.tracked !== 'boolean') throw invalidMetadata();
        if (record.state === 'deleted') {
            if (!record.tracked || Object.keys(record).length !== 2) throw invalidMetadata();
            deleted++;
        } else if (record.state === 'present') {
            if (!evidenceDigestValid(record.sha256) || !count(record.bytes) || record.bytes > bounds.fileBytes
                || typeof record.executable !== 'boolean' || Object.keys(record).length !== 5) throw invalidMetadata();
            files++; bytes += record.bytes; if (!record.tracked) newFiles++;
        } else throw invalidMetadata();
    }
    for (const [name, reason] of excluded) {
        if (!sourcePath(name) || !['generated-or-local-output', 'sensitive-or-active-configuration'].includes(reason)
            || exclusion(name) !== reason || Object.hasOwn(value.records, name)) throw invalidMetadata();
    }
    if (bytes > bounds.totalBytes || files !== value.files || deleted !== value.deleted || bytes !== value.bytes || newFiles !== value.newFiles
        || evidenceDigest(JSON.stringify(value.records)) !== value.digest || !sameCompact(compact(value), inputs)) throw invalidMetadata();
    return value;
}

function currentFailure(reason) {
    return reason === 'CANCELLED' ? 'CANCELLED' : reason === 'INPUT_LIMIT' ? 'CURRENT_SOURCE_LIMIT'
        : reason === 'UNSAFE_SOURCE' ? 'CURRENT_SOURCE_UNSAFE' : reason === 'SOURCE_CHANGED' ? 'CURRENT_SOURCE_CHANGED' : 'CURRENT_SOURCE_UNAVAILABLE';
}

async function currentSnapshot(root, check, signal) {
    if (signal?.aborted) return {snapshot: null, reason: 'CANCELLED'};
    if (check) {
        const observed = await captureCheckSource(root, {signal});
        return {snapshot: observed.snapshot, reason: currentFailure(observed.reason)};
    }
    try { return {snapshot: await sourceSnapshot(root, {signal}), reason: null}; }
    catch (error) { return {snapshot: null, reason: currentFailure(error.code)}; }
}

/** Compare current retained inputs explicitly while keeping recorded pass/fail separate and unchanged. */
export async function verifySource(root, options, {readSummary, signal} = {}) {
    if (!options || Object.keys(options).some(key => !['report', 'expectedReportSha256'].includes(key))
        || typeof readSummary !== 'function' || !evidenceDigestValid(options.expectedReportSha256))
        throw new DiagnosticError('INVALID_ARGUMENT', 'Provide one canonical report and its expected SHA256.');
    const location = evidenceLocation(options.report), result = {report: options.report, reportSha256: null, observedAt: new Date().toISOString(),
        recorded: {status: null, complete: null}, comparison: {state: 'unknown', reason: 'REPORT_UNAVAILABLE',
            scope: 'unsupported-source-protocol', currentSource: null}, limits: [...limits]};
    const unknown = reason => { result.comparison.state = 'unknown'; result.comparison.reason = reason; };
    let reportProof, firstFile, metadataProof, metadataFile, metadataSha256;
    try {
        if (signal?.aborted) { unknown('CANCELLED'); return result; }
        reportProof = await captureEvidencePath(root, options.report);
        firstFile = await readEvidenceFile(root, options.report);
        result.reportSha256 = firstFile.sha256;
        if (firstFile.sha256 !== options.expectedReportSha256) { unknown('REPORT_CHANGED'); return result; }
        const summary = await readSummary(options.report);
        if (!summary || summary.report !== options.report || summary.reportSha256 !== firstFile.sha256)
            throw new DiagnosticError('EVIDENCE_CHANGED', 'The report changed before source observation.');
        if (typeof summary.status !== 'string' || typeof summary.complete !== 'boolean') throw new DiagnosticError('MALFORMED_REPORT');
        result.recorded = {status: summary.status, complete: summary.complete};
        const raw = JSON.parse(firstFile.text), check = location.family === 'check' && raw.schemaVersion === 3;
        let baseline;
        if (check) {
            result.comparison.scope = 'check-v3-recorded-after';
            baseline = summary.source?.after;
            if (!baseline) { unknown('RECORDED_SOURCE_UNAVAILABLE'); return result; }
        } else if (location.family === 'isolated-build' && raw.schemaVersion === 1) {
            result.comparison.scope = 'isolated-build-source-snapshot';
            if (!summary.inputs) { unknown('RECORDED_SOURCE_UNAVAILABLE'); return result; }
            metadataFile = location.directory + '/source-copied.json';
            try {
                metadataProof = await captureEvidencePath(root, metadataFile);
                const metadata = await readOwnedFile(root, metadataFile, {limit: metadataLimit});
                metadataSha256 = metadata.contentSha256;
                if (!evidenceDigestValid(metadataSha256)) throw invalidMetadata();
                baseline = retainedSnapshot(JSON.parse(metadata.text), summary.inputs);
            } catch (error) { unknown(error.code === 'ENOENT' ? 'RETAINED_SOURCE_UNAVAILABLE' : 'RETAINED_SOURCE_INVALID'); return result; }
        } else { unknown('UNSUPPORTED_SOURCE_PROTOCOL'); return result; }
        const firstCurrent = await currentSnapshot(root, check, signal);
        if (!firstCurrent.snapshot) { unknown(firstCurrent.reason); return result; }
        const finalCurrent = await currentSnapshot(root, check, signal);
        if (!finalCurrent.snapshot) { unknown(finalCurrent.reason); return result; }
        result.comparison.currentSource = compact(finalCurrent.snapshot);
        if (!sameSource(firstCurrent.snapshot, finalCurrent.snapshot)) { unknown('CURRENT_SOURCE_CHANGED'); return result; }
        const matches = check ? sameCompact(baseline, compact(finalCurrent.snapshot)) : sameSource(baseline, finalCurrent.snapshot);
        result.comparison.state = matches ? 'match' : 'mismatch';
        result.comparison.reason = matches ? 'SOURCE_MATCH' : 'SOURCE_MISMATCH';
    } catch (error) { unknown(evidenceRejection(error)); }
    finally {
        if (metadataProof && metadataSha256) {
            try {
                await assertEvidencePath(metadataProof);
                const after = await readOwnedFile(root, metadataFile, {limit: metadataLimit});
                if (after.contentSha256 !== metadataSha256) unknown('RETAINED_SOURCE_CHANGED');
            } catch { unknown('RETAINED_SOURCE_CHANGED'); }
        }
        if (reportProof && firstFile) {
            try {
                await assertEvidencePath(reportProof);
                const after = await readEvidenceFile(root, options.report);
                if (after.sha256 !== firstFile.sha256 || after.sha256 !== options.expectedReportSha256) {
                    result.reportSha256 = after.sha256; result.recorded = {status: null, complete: null}; result.comparison.currentSource = null;
                    unknown('REPORT_CHANGED');
                }
            } catch (error) {
                result.reportSha256 = null; result.recorded = {status: null, complete: null}; result.comparison.currentSource = null;
                unknown(evidenceRejection(error));
            }
        }
        if (signal?.aborted) unknown('CANCELLED');
        result.observedAt = new Date().toISOString();
    }
    return result;
}
