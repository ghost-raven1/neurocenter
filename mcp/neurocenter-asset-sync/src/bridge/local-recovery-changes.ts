import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits, modify, parse, parseTree, type ParseError } from 'jsonc-parser';
import { CONFIG_PATHS } from './installation-files.js';
import { LEDGER_PATH } from './installation-ledger.js';
import { assetBase, assetKey, receiptPath, sameValue } from './installation-receipt.js';
import type { Package } from './package.js';
import type { RecoveryContext } from './local-recovery-context.js';
import { LocalRecoveryError, type RecoverySource } from './local-recovery.model.js';

function config(text: string | null): Record<string,unknown> {
    const errors: ParseError[] = []; const source = text ?? '{}';
    const value = parse(source,errors,{allowTrailingComma:true}); const tree = parseTree(source,[],{allowTrailingComma:true});
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value) || !tree) { throw new LocalRecoveryError('invalid-backup'); }
    const nodes = [tree]; let count = 0;
    while (nodes.length) {
        const node = nodes.pop()!; if (++count > 100000) { throw new LocalRecoveryError('limit-exceeded'); }
        if (node.type === 'object') {
            const keys = node.children?.map(child => child.children?.[0]?.value) ?? [];
            if (new Set(keys).size !== keys.length) { throw new LocalRecoveryError('invalid-backup'); }
        }
        nodes.push(...node.children ?? []);
    }
    if (value.mcp !== undefined && (!value.mcp || typeof value.mcp !== 'object' || Array.isArray(value.mcp))
        || value.plugin !== undefined && !Array.isArray(value.plugin)) { throw new LocalRecoveryError('invalid-backup'); }
    return value;
}
function ownedSpec(value: unknown, root: string, pkg: Package): boolean {
    if (typeof value !== 'string') { return false; }
    try {
        const url = new URL(value); if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) { return false; }
        const relative = path.relative(path.join(root,assetBase(pkg)),fileURLToPath(url));
        return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    } catch { return false; }
}
function remap(value: unknown, oldRoot: string, root: string, pkg: Package, depth = 0): unknown {
    if (depth > 32) { throw new LocalRecoveryError('limit-exceeded'); }
    if (Array.isArray(value)) { return value.map(item => remap(item,oldRoot,root,pkg,depth+1)); }
    if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,remap(item,oldRoot,root,pkg,depth+1)])); }
    if (typeof value !== 'string' || oldRoot === root) { return value; }
    if (ownedSpec(value,oldRoot,pkg)) { return pathToFileURL(path.join(root,path.relative(oldRoot,fileURLToPath(value)))).href; }
    if (path.isAbsolute(value)) {
        const relative = path.relative(path.join(oldRoot,assetBase(pkg)),value);
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) { return path.join(root,assetBase(pkg),relative); }
    }
    return value;
}
interface Target { relative: string; after: string | null; encoding?: 'base64' }

/** Из полной копии извлекаются только известные payload-файлы и собственные элементы JSONC. */
export async function recoveryTargets(context: RecoveryContext, source: RecoverySource, selected?: string[]): Promise<Target[]> {
    if (source.reason !== 'ready') { throw new LocalRecoveryError(source.reason); }
    const payload = new Map(context.packages.flatMap(pkg => pkg.files.map(file => [assetBase(pkg) + '/' + file.path,pkg] as const)));
    const metadata = new Set([LEDGER_PATH,...context.packages.map(receiptPath)]);
    const changes = source.journal.changes;
    if (changes.some(change => !payload.has(change.relative) && !metadata.has(change.relative) && !CONFIG_PATHS.includes(change.relative))) { throw new LocalRecoveryError('invalid-backup'); }
    const available = new Set(changes.filter(change => payload.has(change.relative) || CONFIG_PATHS.includes(change.relative)).map(change => change.relative));
    if (selected !== undefined && (!Array.isArray(selected) || selected.length > 512 || !selected.length || new Set(selected).size !== selected.length
        || selected.some(relative => typeof relative !== 'string' || !available.has(relative)))) { throw new LocalRecoveryError('no-restorable-files'); }
    const wanted = new Set(selected ?? available); const targets: Target[] = [];
    for (const change of changes) {
        if (!wanted.has(change.relative)) { continue; }
        const member = payload.get(change.relative);
        if (member) {
            const after = change.before === null ? null : Buffer.from(change.before,change.encoding ?? 'utf8').toString('base64');
            const before = await context.plan.read(change.relative,'base64'); const key = assetKey(member);
            if (before !== after && context.shared(key)) { throw new LocalRecoveryError('shared-dependency'); }
            targets.push({relative:change.relative,after,encoding:'base64'}); continue;
        }
        if (!CONFIG_PATHS.includes(change.relative)) { continue; }
        const bytes = change.before === null ? null : Buffer.from(change.before,change.encoding ?? 'utf8');
        const priorText = bytes?.toString('utf8') ?? null;
        if (bytes && !Buffer.from(priorText!).equals(bytes)) { throw new LocalRecoveryError('invalid-backup'); }
        const old = config(priorText);
        let text = await context.plan.read(change.relative); const original = text;
        const members = context.packages.filter(pkg => context.receipts.get(assetKey(pkg))?.config?.path === change.relative);
        if (!members.length) { throw new LocalRecoveryError('invalid-backup'); }
        for (const pkg of members) {
            const receipt = context.receipts.get(assetKey(pkg))!; const key = assetKey(pkg); const current = config(text);
            let editPath: (string | number)[]; let desired: unknown; let existing: unknown;
            if (pkg.plugin.kind === 'mcp') {
                editPath = ['mcp',receipt.config!.key]; desired = remap((old.mcp as Record<string,unknown> | undefined)?.[receipt.config!.key],source.journal.root,context.root,pkg);
                existing = (current.mcp as Record<string,unknown> | undefined)?.[receipt.config!.key];
            } else {
                const oldOwned = (old.plugin as unknown[] ?? []).filter(value => ownedSpec(value,source.journal.root,pkg));
                const plugins = current.plugin as unknown[] ?? [];
                const indices = plugins.flatMap((value,index) => value === receipt.config!.value || ownedSpec(value,context.root,pkg) ? [index] : []);
                if (oldOwned.length > 1 || indices.length > 1) { throw new LocalRecoveryError('invalid-backup'); }
                desired = remap(oldOwned[0],source.journal.root,context.root,pkg); existing = indices.length ? plugins[indices[0]!] : undefined;
                editPath = ['plugin',indices[0] ?? plugins.length];
            }
            if (sameValue(existing,desired)) { continue; }
            if (context.shared(key)) { throw new LocalRecoveryError('shared-dependency'); }
            text = applyEdits(text ?? '{}\n',modify(text ?? '{}\n',editPath,desired,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));
        }
        // Отсутствующее целиком config не создаётся ради отсутствующего же собственного элемента.
        targets.push({relative:change.relative,after:text === original ? original : text});
    }
    if (!targets.length) { throw new LocalRecoveryError('no-restorable-files'); }
    return targets;
}
