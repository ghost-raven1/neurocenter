import path from 'node:path';
import {readOwnedFile} from './safe-file.mjs';
import {DiagnosticError} from './constants.mjs';
import {isLaunchId, launchServices, inspectLaunchProcess} from '../workspace/dev-launch-provenance.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pid = value => Number.isSafeInteger(value) && value > 0;
const birth = value => typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value));
const unknown = reason => ({state: 'unknown', reason});
const malformed = () => new DiagnosticError('MALFORMED_REPORT', 'The selected launch receipt is incomplete or unsupported.');

async function json(root, relative) {
    try { return JSON.parse((await readOwnedFile(root, relative, {limit: 16384, privateMode: true})).text); }
    catch (error) { if (error instanceof SyntaxError) throw malformed(); throw error; }
}

async function index(root, directory) {
    const file = await readOwnedFile(root, directory + '/current.json', {limit: 1024, privateMode: true});
    let value; try { value = JSON.parse(file.text); } catch { throw malformed(); }
    if (value?.schemaVersion !== 1 || !isLaunchId(value.launchId)) throw malformed();
    return {launchId: value.launchId, dev: file.fileDev, ino: file.fileIno, sha256: file.contentSha256};
}

/** Bounded fixed-service history; text labels never establish launch or current-process identity. */
export async function readDevLaunchLog(root, service, {launchId, maxBytes = 32768, inspect = true, inspectProcess = inspectLaunchProcess, signal} = {}) {
    if (!launchServices.includes(service) || launchId !== undefined && !isLaunchId(launchId)
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 2 || typeof inspect !== 'boolean')
        throw new DiagnosticError('INVALID_ARGUMENT', 'Choose a fixed service, launch UUID and bounded read.');
    signal?.throwIfAborted();
    const directory = '.run/dev-launches/' + service;
    let current;
    if (launchId === undefined) try { current = await index(root, directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!current && launchId === undefined) {
        const logPath = '.run/logs/neurocenter-' + service + '.log', file = await readOwnedFile(root, logPath, {limit: maxBytes, tail: true});
        return {...file, logPath, launch: null, currentProcessCorrelation: unknown('append-log-without-launch-provenance')};
    }
    const selected = launchId ?? current.launchId;
    let receipt;
    try { receipt = await json(root, directory + '/' + selected + '.json'); }
    catch (error) { if (error.code === 'ENOENT') throw new DiagnosticError('NOT_FOUND', 'The selected service launch was not retained.'); throw error; }
    const logPath = '.run/logs/neurocenter-' + service + '-' + selected + '.log';
    if (receipt?.schemaVersion !== 1 || receipt.kind !== 'neurocenter-dev-launch' || receipt.service !== service || receipt.launchId !== selected
        || receipt.generation !== null && !isLaunchId(receipt.generation) || !digest(receipt.entryDigest)
        || receipt.sourceSha256 !== null && !digest(receipt.sourceSha256) || !birth(receipt.startedAt)
        || !pid(receipt.launcher?.pid) || !birth(receipt.launcher.birth) || !pid(receipt.owner?.pid) || !birth(receipt.owner.birth)
        || !pid(receipt.process?.pid) || !birth(receipt.process.birth) || !path.isAbsolute(receipt.process.cwd ?? '')
        || receipt.log?.path !== logPath || !Number.isSafeInteger(receipt.log.dev) || !Number.isSafeInteger(receipt.log.ino)) throw malformed();
    const file = await readOwnedFile(root, logPath, {limit: maxBytes, tail: true, privateMode: true});
    if (file.fileDev !== receipt.log.dev || file.fileIno !== receipt.log.ino)
        return {...file, logPath, launch: null, currentProcessCorrelation: unknown('launch-log-identity-changed')};
    const launch = {launchId: selected, generation: receipt.generation, entryDigest: receipt.entryDigest, sourceSha256: receipt.sourceSha256, startedAt: receipt.startedAt};
    let correlation;
    if (!inspect) correlation = unknown('launch-inspection-disabled');
    else {
        signal?.throwIfAborted();
        let observed, owner;
        try { observed = inspectProcess(receipt.process.pid); owner = receipt.owner.pid === receipt.process.pid ? observed : inspectProcess(receipt.owner.pid); }
        catch { observed = {state: 'unknown'}; }
        if (observed.state === 'ended') correlation = {state: 'historical', reason: 'launch-process-ended'};
        else if (observed.state !== 'observed' || owner?.state !== 'observed') correlation = unknown('launch-inspection-unavailable');
        else if (observed.birth !== receipt.process.birth || owner.birth !== receipt.owner.birth) correlation = unknown('launch-pid-reused');
        else if (observed.cwd !== receipt.process.cwd) correlation = unknown('launch-process-directory-changed');
        else if (observed.outputs?.length !== 2 || observed.outputs.some(item => !item || item.dev !== file.fileDev || item.ino !== file.fileIno))
            correlation = unknown('launch-output-identity-changed');
        else correlation = launchId === undefined && current?.launchId === selected ? {state: 'owned', reason: 'matched-launch-process', pid: receipt.process.pid}
            : {state: 'historical', reason: 'retained-launch'};
    }
    if (launchId === undefined) {
        let after; try { after = await index(root, directory); } catch {}
        if (!after || after.launchId !== current.launchId || after.dev !== current.dev || after.ino !== current.ino || after.sha256 !== current.sha256)
            correlation = unknown('launch-index-changed');
    }
    signal?.throwIfAborted();
    return {...file, logPath, launch, currentProcessCorrelation: correlation};
}
