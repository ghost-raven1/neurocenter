import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectLaunchProcess} from './dev-launch-inspection.mjs';
import {groupAlive} from './dev-watch-owned.mjs';

const pid = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const birth = value => typeof value === 'string' && value.length < 64 && Number.isFinite(Date.parse(value));
const unknown = reason => ({state: 'unknown', reason});
const sameLog = (output, expected) => output && output.dev === expected.dev && output.ino === expected.ino;

function allowedEntry(root, service, entry) {
    if (typeof entry !== 'string' || entry.length > 8192 || entry.includes('\\') || /[\x00-\x1f\x7f]/.test(entry)
        || path.posix.isAbsolute(entry) || path.posix.normalize(entry) !== entry || entry.split('/').includes('..')) return false;
    const direct = service.entry && path.isAbsolute(service.entry) ? path.relative(root, service.entry)
        : path.posix.join(service.dir, service.entry ?? (service.name === 'frontend' ? 'node_modules/vite/bin/vite.js' : 'dist/main.js'));
    if (entry === direct) return true;
    const parts = entry.split('/');
    return parts[0] === '.run' && parts[1] === 'dev-watch' && parts[2] === 'generations'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parts[3] ?? '')
        && parts.slice(4).join('/') === 'repository/' + service.dir + '/dist/main.js';
}

/** A fresh actual-process witness permits orphan cleanup even when its JS loop cannot receive IPC EOF. */
export async function recoverDevLaunch(root, record, service, {inspectProcess = inspectLaunchProcess, groupIsAlive = groupAlive,
    sendGroup = (pgid, signal) => process.kill(-pgid, signal), timeoutMs = 2000} = {}) {
    const witness = record?.serviceWitness;
    if (witness === undefined) return {state: 'legacy'};
    if (!service || !pid(record.pid) || record.name !== service.name || witness?.schemaVersion !== 1 || !pid(witness.pid)
        || witness.pid === record.pid || witness.pgid !== record.pid || !birth(witness.birth) || !birth(witness.ownerBirth)
        || witness.directory !== service.dir || !allowedEntry(root, service, witness.entry) || !digest(witness.commandSha256)
        || !Number.isSafeInteger(witness.log?.dev) || !Number.isSafeInteger(witness.log?.ino)) return unknown('DEV_LAUNCH_WITNESS_INVALID');
    let directory;
    try { directory = await fs.realpath(path.join(root, service.dir)); }
    catch { return unknown('DEV_LAUNCH_RECOVERY_UNKNOWN'); }
    const matches = observed => observed?.state === 'observed' && observed.pid === witness.pid && observed.birth === witness.birth
        && observed.cwd === directory && observed.pgid === record.pid && observed.commandSha256 === witness.commandSha256
        && observed.outputs?.length === 2 && observed.outputs.every(output => sameLog(output, witness.log));
    try {
        const owner = inspectProcess(record.pid);
        if (owner.state !== 'ended') return unknown('DEV_LAUNCH_OWNER_NOT_ENDED');
        const actual = inspectProcess(witness.pid);
        if (actual.state === 'ended') return groupIsAlive(record.pid) ? unknown('DEV_LAUNCH_GROUP_UNPROVEN') : {state: 'gone'};
        if (!matches(actual)) return unknown('DEV_LAUNCH_WITNESS_CHANGED');
        // The live witness pins this private group. No later signal is sent after it has exited.
        if (inspectProcess(record.pid).state !== 'ended' || !matches(inspectProcess(witness.pid))) return unknown('DEV_LAUNCH_WITNESS_CHANGED');
        sendGroup(record.pid, 'SIGKILL');
        const deadline = Date.now() + timeoutMs;
        while (groupIsAlive(record.pid) && Date.now() < deadline) await delay(25);
        return groupIsAlive(record.pid) ? unknown('DEV_LAUNCH_RECOVERY_INCOMPLETE') : {state: 'stopped'};
    } catch { return unknown('DEV_LAUNCH_RECOVERY_UNKNOWN'); }
}
