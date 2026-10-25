#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parsePostgresArguments, postgresHelp, QaPostgresError} from './postgres-contract.mjs';
import {planQaPostgres, createQaPostgres, inspectQaPostgres, closeQaPostgres, publicQaPostgres} from './postgres-runtime.mjs';

const workspace = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Keep secrets out of CLI output and preserve read/close access when fixture creation is disabled. */
export async function main(args, {root = workspace, environment = process.env, output = process.stdout, errorOutput = process.stderr} = {}) {
    const options = parsePostgresArguments(args, environment);
    if (options.help) { output.write(postgresHelp + '\n'); return 0; }
    const controller = new AbortController(), interrupt = () => controller.abort('SIGINT'), terminate = () => controller.abort('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    try {
        const result = options.action === 'plan' ? await planQaPostgres(root, options)
            : options.action === 'create' ? await createQaPostgres(root, options, {environment, signal: controller.signal})
            : options.action === 'close' ? await closeQaPostgres(root, options.runId, {signal: controller.signal})
            : publicQaPostgres(await inspectQaPostgres(root, options.runId));
        output.write(JSON.stringify(result, null, 2) + '\n');
        return options.action === 'create' ? result.ready ? 0 : 1 : options.action === 'inspect' ? result.ownership === 'unknown' ? 1 : 0 : 0;
    } catch (error) {
        errorOutput.write((error instanceof QaPostgresError ? error.code : 'QA_OPERATION_FAILED') + '\n');
        return controller.signal.aborted ? controller.signal.reason === 'SIGTERM' ? 143 : 130 : 1;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    try { process.exitCode = await main(process.argv.slice(2)); }
    catch (error) { console.error(error instanceof QaPostgresError ? error.code : 'QA_OPERATION_FAILED'); process.exitCode = 1; }
}
