import { resolvePreparedRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import { runtimeArtifactConnection } from '../features/runtime-artifacts/connection.js';
import { configurationConnection } from '../features/local-configuration/launcher-descriptor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, type ParseError } from 'jsonc-parser';
import { hash, hub, apiHub, stateDir } from './state.js';
import { isHostedMcpUrl } from '../features/mcp-host/connect.js';
import { verify, type Package } from './package.js';
import { projectFolder, projectBindingId, safeTarget } from './workspace.js';
import { assetBase, legacyMcpConfigKey, mcpConfigKey, receiptPath, removalReceipt, sameValue, type Receipt } from './installation-receipt.js';
import { CONFIG_PATHS } from './installation-files.js';
import { LEDGER_PATH } from './installation-ledger.js';
import { inspectLedger } from './inspection-ledger.js';
import { InspectionReader, InspectionReadError } from './inspection-reader.js';
import type { InstallationInspection, InspectionIssue, InspectionStatus } from './installation-inspection.model.js';

const severity = { synced: 0, missing: 1, modified: 2, unknown: 3 };
function utf8(bytes: Buffer): string {
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) { throw new Error(); }
    return text;
}
async function busy(root: string): Promise<boolean> {
    const directory = path.join(stateDir(), 'file-changes', hash(root));
    const paths = [await safeTarget(root, '.opencode/neurocenter/files.lock'), path.join(directory, 'pending.json'), path.join(directory, 'recovery.lock')];
    for (const file of paths) {
        try { await fs.lstat(file); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return true; } }
    }
    return false;
}
function expectedConnection(root: string, pkg: Package): unknown {
    const configured = configurationConnection(root, pkg); if (configured) { return configured; }
    const runtime = runtimeArtifactConnection(pkg);
    if (runtime) { return pkg.plugin.kind === 'plugin' ? pathToFileURL(runtime.entrypoint).href : {type:'local',enabled:true,command:runtime.command,...(pkg.config?.env ? {environment:pkg.config.env} : {})}; }
    const config = pkg.config;
    if (pkg.plugin.kind === 'plugin') {
        if (!config?.entrypoint || !pkg.files.some(file => file.path === config.entrypoint)) { throw new Error(); }
        return pathToFileURL(path.join(root, assetBase(pkg), config.entrypoint)).href;
    }
    if (!config) { throw new Error(); }
    if (config.transport === 'remote') {
        const url = new URL(config.url ?? '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error(); }
        return { type: 'remote', enabled: true, url: url.href, ...(config.headers ? { headers: config.headers } : {}), ...(config.oauth === false ? { oauth: false } : {}) };
    }
    if (!config.command || pkg.files.length && (!config.entrypoint || !pkg.files.some(file => file.path === config.entrypoint))) { throw new Error(); }
    return { type: 'local', enabled: true, command: pkg.files.length
        ? [process.execPath, path.join(root, assetBase(pkg), config.entrypoint!), ...(config.args ?? [])]
        : [config.command, ...(config.args ?? [])], ...(config.env ? { environment: config.env } : {}) };
}
function connectionMatches(value: unknown, expected: unknown, pkg: Package): 'equal' | 'runtime' | 'different' {
    if (sameValue(value, expected)) { return 'equal'; }
    if (pkg.plugin.kind === 'mcp' && pkg.files.length && pkg.config?.transport !== 'remote' && value && typeof value === 'object') {
        const config = value as { command?: unknown };
        if (Array.isArray(config.command) && typeof config.command[0] === 'string' && path.isAbsolute(config.command[0])
            && sameValue({ ...value, command: [process.execPath, ...config.command.slice(1)] }, expected)) { return 'runtime'; }
    }
    return 'different';
}

/** Сверяет только данные известного пакета; не запускает его и не восстанавливает файловый журнал. */
export async function inspectInstallation(projectId: string, pkg: Package): Promise<InstallationInspection> {
    const root = await projectFolder(projectId);
    const bindingId = await projectBindingId(projectId);
    return inspectInstallationAt(root,projectId,bindingId,pkg);
}

/** Мастер проверяет непривязанную папку под тем же файловым lock, не принимая её marker за доказательство. */
export async function inspectInstallationAt(root: string, projectId: string, bindingId: string, pkg: Package,
    options: { lockHeld?: boolean; configRoot?: string; assertIdentity?: () => Promise<void> } = {}): Promise<InstallationInspection> {
    const configRoot = options.configRoot ?? root;
    const result: InstallationInspection = { schemaVersion: 1, projectId, bindingId, assetId: pkg.plugin.id, assetKind: pkg.plugin.kind,
        version: pkg.plugin.version, manifest: pkg.manifest.sha256, checkedAt: new Date().toISOString(), readiness: 'unverified',
        state: 'checked', status: 'synced', issues: [] };
    const issue = (code: InspectionIssue, status: InspectionStatus = 'unknown'): void => {
        if (!result.issues.includes(code)) { result.issues.push(code); }
        if (severity[status] > severity[result.status]) { result.status = status; }
    };
    const occupied = (code: InspectionIssue): InstallationInspection => ({ ...result, state: 'busy', status: 'unknown', issues: [code] });
    const reader = new InspectionReader(root);
    const read = async (relative: string, maximum: number): Promise<Buffer | null | undefined> => {
        try { return await reader.read(relative, maximum); }
        catch (error) {
            if (error instanceof InspectionReadError && error.issue === 'source-changed') { throw error; }
            const code = error instanceof InspectionReadError ? error.issue : 'read-failed';
            issue(code === 'unsafe-path' ? 'file-unsafe' : code === 'read-limit' ? 'limit-exceeded' : 'read-failed');
            return undefined;
        }
    };
    try {
        verify(pkg);
        const rawReceipt = await read(receiptPath(pkg), 256 * 1024);
        let receipt: Receipt | undefined;
        if (rawReceipt === null) { issue('receipt-missing', 'missing'); }
        else if (rawReceipt) {
            try {
                const parsed = JSON.parse(utf8(rawReceipt)) as Receipt;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) { throw new Error(); }
                try { receipt = removalReceipt(utf8(rawReceipt), pkg); }
                catch { issue('receipt-mismatch', 'modified'); }
            } catch { issue('receipt-invalid'); }
        }
        const receiptValue = (receipt?.config?.value ?? null) as { type?: unknown; url?: unknown } | null;
        const hostedInstallation = pkg.plugin.kind === 'mcp' && !!receiptValue && typeof receiptValue === 'object'
            && receiptValue.type === 'remote' && isHostedMcpUrl(receiptValue.url)
            && (() => { try { return [hub(),apiHub()].includes(new URL(receiptValue.url).origin); } catch { return false; } })();
        // Платформа исполняет комплекс: локальный кэш для такой установки не требуется.
        if (!hostedInstallation) { await resolvePreparedRuntimeArtifact(pkg); }
        if (!options.lockHeld && await busy(root)) { return occupied('inspection-busy'); }
        const ledger = await read(LEDGER_PATH, 4 * 1048576);
        if (ledger === null) { issue('ledger-missing'); }
        else if (ledger) {
            const state = inspectLedger(ledger, pkg);
            if (state !== 'valid') { issue(state === 'invalid' ? 'ledger-invalid' : 'ledger-mismatch'); }
        }
        for (const file of pkg.files) {
            const bytes = await read(`${assetBase(pkg)}/${file.path}`, 1048576);
            if (bytes === null) { issue('file-missing', 'missing'); }
            else if (bytes && (bytes.length !== file.size || hash(bytes) !== file.sha256)) { issue('file-modified', 'modified'); }
        }
        if (pkg.plugin.kind !== 'skill') {
            const expected = hostedInstallation && receipt?.config ? receipt.config.value : expectedConnection(configRoot, pkg);
            if (receipt?.config) {
                const match = connectionMatches(receipt.config.value, expected, pkg);
                if (match === 'runtime') { issue('runtime-path-unverified'); }
                else if (match !== 'equal') { issue('receipt-mismatch', 'modified'); }
            }
            const candidates: Array<{ relative: string; value: unknown }> = [];
            for (const relative of CONFIG_PATHS) {
                const bytes = await read(relative, 1048576);
                if (!bytes) { continue; }
                try {
                    const errors: ParseError[] = [];
                    const config = parse(utf8(bytes), errors, { allowTrailingComma: true }) as Record<string, unknown>;
                    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) { throw new Error(); }
                    if (pkg.plugin.kind === 'mcp') {
                        if (config.mcp !== undefined && (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp))) { throw new Error(); }
                        const mcpEntries = (config.mcp as Record<string, unknown> | undefined) ?? {};
                        const value = mcpEntries[mcpConfigKey(pkg)] ?? mcpEntries[legacyMcpConfigKey(pkg)];
                        if (value !== undefined) { candidates.push({ relative, value }); }
                    } else {
                        if (config.plugin !== undefined && !Array.isArray(config.plugin)) { throw new Error(); }
                        for (const value of config.plugin as unknown[] ?? []) {
                            if (value === expected || typeof value === 'string' && value.startsWith(pathToFileURL(path.join(configRoot, assetBase(pkg))).href + '/')) { candidates.push({ relative, value }); }
                        }
                    }
                } catch { issue('config-invalid'); }
            }
            if (!candidates.length) { issue('config-missing', 'missing'); }
            else if (candidates.length > 1) { issue('config-ambiguous'); }
            for (const candidate of candidates) {
                const match = connectionMatches(candidate.value, expected, pkg);
                if (match === 'runtime') { issue('runtime-path-unverified'); }
                else if (match !== 'equal') { issue('config-modified', 'modified'); }
                if (receipt?.config && (receipt.config.path !== candidate.relative || !sameValue(receipt.config.value, candidate.value))) { issue('config-modified', 'modified'); }
            }
        }
        try {
            if (options.assertIdentity) { await options.assertIdentity(); }
            else if (!options.lockHeld && (await projectFolder(projectId) !== root || await projectBindingId(projectId) !== bindingId)) { return occupied('binding-changed'); }
        } catch { return occupied('binding-changed'); }
        if (!options.lockHeld && await busy(root)) { return occupied('inspection-busy'); }
        await reader.verify();
        result.issues.sort();
        if (Buffer.byteLength(JSON.stringify(result)) > 8500) { throw new Error(); }
        return result;
    } catch (error) {
        if (error instanceof InspectionReadError && error.issue === 'source-changed') { return occupied('snapshot-changed'); }
        issue('inspection-failed');
        return result;
    }
}
