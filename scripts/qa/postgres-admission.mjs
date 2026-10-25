import path from 'node:path';
import {postgresPaths, isRunId, QaPostgresError, assertPostgresFlag} from './postgres-contract.mjs';
import {inspectQaPostgres} from './postgres-runtime.mjs';

/** Native harnesses admit only a currently ready, leased fixture with complete managed ownership proof. */
export async function admitManagedPostgres(file, {root, environment = process.env, ...dependencies} = {}) {
    assertPostgresFlag(environment, 'run');
    if (!path.isAbsolute(file ?? '') || path.resolve(file) !== file || !root) throw new QaPostgresError('QA_INVALID_ARGUMENT');
    const runId = path.basename(path.dirname(file));
    if (!isRunId(runId) || file !== postgresPaths(root, runId).connection) throw new QaPostgresError('QA_UNSAFE_PATH');
    const observed = await inspectQaPostgres(root, runId, dependencies);
    if (observed.ownership !== 'owned' || !observed.ready) throw new QaPostgresError(observed.reason || 'QA_OWNERSHIP_UNKNOWN');
    if (Date.now() >= Date.parse(observed.owner.expiresAt)) throw new QaPostgresError('QA_LEASE_EXPIRED');
    return {config: observed.connection, url: observed.url, owner: observed.owner, proof: observed.proof};
}
