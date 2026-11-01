import path from 'node:path';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (value) => value.split(path.sep).join('/');
/** Reviewed mock-only paths. Never refresh these pins automatically after a test/helper edit. */
export const auditedUnits = Object.freeze({});

const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
const dependencies = new RegExp(
    String.raw`(?:\bfrom${gap}|\bimport${gap}(?:\(${gap})?|\brequire${gap}\(${gap})(['"])([^'"\r\n]+)\1`,
    'g',
);
/** Literal dependencies are inspected, never imported; ambiguous strings can only deny an exemption. */
export function runtimeDependencies(source) {
    return [...source.matchAll(dependencies)].map((match) => match[2]);
}
export function runtimePg(source) {
    return runtimeDependencies(source).includes('pg');
}
const verification = (relative) => /(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)/.test(relative);
const reAudit = (relative) =>
    Error(
        'Unit-safe audit changed: ' +
            relative +
            '. Re-audit this test and its runtime test helpers, then update scripts/coverage/unit-safe-profile.mjs after review; no automatic SHA refresh.',
    );

async function ordinaryBytes(root, relative) {
    const absolute = path.resolve(root, relative);
    if (!relative || path.isAbsolute(relative) || slash(path.relative(root, absolute)) !== relative)
        throw reAudit(relative);
    try {
        if (!(await lstat(absolute)).isFile() || (await realpath(absolute)) !== absolute) throw reAudit(relative);
        return await readFile(absolute);
    } catch {
        throw reAudit(relative);
    }
}

/** Source and every permitted verification helper must retain the reviewed exact bytes. */
export async function validateAuditedUnit(root, relative, entry = auditedUnits[relative]) {
    if (!entry) throw reAudit(relative);
    const bytes = await ordinaryBytes(root, relative);
    if (digest(bytes) !== entry.sha256) throw reAudit(relative);
    let runtime;
    try {
        runtime = stripTypeScriptTypes(bytes.toString('utf8'), { mode: 'strip' });
    } catch {
        throw reAudit(relative);
    }
    const modules = runtimeDependencies(runtime);
    if (modules.some((name) => ['pg', 'minio', '@aws-sdk/client-s3'].includes(name))) throw reAudit(relative);
    if (modules.some((name) => path.isAbsolute(name) || name.startsWith('file:'))) throw reAudit(relative);
    const local = modules
        .filter((name) => name.startsWith('.'))
        .map((name) => slash(path.relative(root, path.resolve(root, path.dirname(relative), name))));
    if (local.some((name) => name.startsWith('../') || path.isAbsolute(name))) throw reAudit(relative);
    const helpers = [...new Set(local.filter((name) => verification(name)))].sort();
    if (JSON.stringify(helpers) !== JSON.stringify(Object.keys(entry.helpers).sort())) throw reAudit(relative);
    for (const helper of helpers) {
        const content = await ordinaryBytes(root, helper);
        if (digest(content) !== entry.helpers[helper]) throw reAudit(helper);
        // The sole reviewed helper is self-contained. No newly chained fixture is implicitly approved.
        if (
            runtimeDependencies(content.toString('utf8')).some(
                (name) =>
                    ['pg', 'minio', '@aws-sdk/client-s3'].includes(name) ||
                    name.startsWith('.') ||
                    path.isAbsolute(name) ||
                    name.startsWith('file:'),
            )
        )
            throw reAudit(helper);
    }
    return runtime;
}

/** An exact reviewed exception removes only the legacy type-only pg import signal. */
export async function auditedUnitException(file, root = repository) {
    const relative = slash(path.relative(root, file));
    if (!Object.hasOwn(auditedUnits, relative)) return false;
    await validateAuditedUnit(root, relative);
    return true;
}

/** Preflight only the requested scope before output, any worker, or infrastructure admission. */
export async function validateUnitSafeProfile(root, { packages, chosen, testFiles = [] }) {
    const folders = packages.filter(([id]) => !chosen.size || chosen.has(id)).map(([, folder]) => folder);
    for (const relative of Object.keys(auditedUnits)) {
        const folder = folders.find((folder) => relative.startsWith(folder + '/'));
        if (folder && (!testFiles.length || testFiles.includes(relative.slice(folder.length + 1))))
            await validateAuditedUnit(root, relative);
    }
}
