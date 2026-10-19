import { verify, type Package } from './package.js';
import { packageDependencies, packageRef, sortedRefs, verifyInstallSet, type InstallSet } from './install-set.js';
import path from 'node:path';
import { assetBase, assetKey, receiptPath, removalReceipt, sameValue, type Receipt } from './installation-receipt.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger, LEDGER_PATH } from './installation-ledger.js';
import { repairReceipt } from './installation-repair.js';
import { projectFolder, projectBindingId, projectInstanceId } from './workspace.js';
import { LocalRecoveryError } from './local-recovery.model.js';
import { expectedAdoptConnection } from './project-inventory-config.js';

/** Клонируем закреплённый граф до await, чтобы внешняя мутация не меняла выбранные байты. */
export function freezeRecoveryPackages(pkg: Package, set?: InstallSet) {
    pkg = structuredClone(pkg); set = set ? structuredClone(set) : undefined; verify(pkg);
    if (set) {
        verifyInstallSet(set);
        if (!sameValue(set.root,packageRef(pkg))) { throw new LocalRecoveryError('different-installation'); }
    } else if (packageDependencies(pkg).length) { throw new LocalRecoveryError('different-installation'); }
    return {pkg,packages:set?.packages ?? [pkg],manifest:set?.manifest ?? pkg.manifest.sha256};
}
export type RecoveryPackages = ReturnType<typeof freezeRecoveryPackages>;
export async function recoveryContext(projectId: string, root: string, frozen: RecoveryPackages) {
    const bindingId = await projectBindingId(projectId); const instanceId = await projectInstanceId(projectId);
    const bases = frozen.packages.map(member => assetBase(member).normalize('NFC').toLowerCase());
    if (new Set(bases).size !== bases.length) { throw new LocalRecoveryError('different-installation'); }
    const plan = new InstallationPlan(root); await InstallationLedger.load(plan);
    const ledgerText = await plan.read(LEDGER_PATH);
    if (!ledgerText) { throw new LocalRecoveryError('different-installation'); }
    const ledger = JSON.parse(ledgerText) as { roots: Record<string,{manifest:string;packages:Array<{key:string;kind?:string;id?:string;version:number;manifest:string}>}> };
    const owner = ledger.roots[assetKey(frozen.pkg)];
    const refs = owner?.packages.map(({kind,id,version,manifest}) => ({kind,id,version,manifest}))
        .sort((a,b) => (a.kind ?? '') < (b.kind ?? '') ? -1 : a.kind !== b.kind ? 1 : (a.id ?? '') < (b.id ?? '') ? -1 : a.id === b.id ? 0 : 1);
    const leaf = frozen.packages.length === 1 && Object.values(ledger.roots).some(value => value.packages.some(item => item.key === assetKey(frozen.pkg)
        && item.version === frozen.pkg.plugin.version && item.manifest === frozen.pkg.manifest.sha256));
    if (owner ? owner.manifest !== frozen.manifest || !sameValue(refs,sortedRefs(frozen.packages)) : !leaf) { throw new LocalRecoveryError('different-installation'); }
    const receipts = new Map<string,Receipt>();
    for (const member of frozen.packages) {
        const raw = await plan.read(receiptPath(member));
        if (!raw) { throw new LocalRecoveryError('different-installation'); }
        const stored = removalReceipt(raw,member);
        if (member.plugin.kind !== 'skill') {
            let actual = stored.config!.value; const expected = expectedAdoptConnection(root,member);
            // Старый абсолютный Node допустим как metadata; проверка запуска всё равно отдельная.
            if (member.plugin.kind === 'mcp' && member.files.length && actual && typeof actual === 'object') {
                const command = (actual as {command?:unknown}).command;
                if (Array.isArray(command) && typeof command[0] === 'string' && path.isAbsolute(command[0])) { actual = {...actual,command:[process.execPath,...command.slice(1)]}; }
            }
            if (!sameValue(actual,expected)) { throw new LocalRecoveryError('different-installation'); }
        }
        receipts.set(assetKey(member),await repairReceipt(plan,raw,member));
    }
    const selectedKeys = new Set(frozen.packages.map(assetKey));
    const examined = new Set<string>();
    for (const owner of Object.values(ledger.roots)) {
        for (const item of owner.packages) {
            if (selectedKeys.has(item.key) || examined.has(item.key)) { continue; } examined.add(item.key);
            const raw = await plan.read('.opencode/neurocenter/receipts/' + item.key + '.json');
            const other = raw ? JSON.parse(raw) as Receipt : undefined;
            if (!other?.files || typeof other.files !== 'object' || Array.isArray(other.files)) { throw new LocalRecoveryError('different-installation'); }
            if (Object.keys(other.files).some(relative => bases.some(base => {
                const normalized = relative.normalize('NFC').toLowerCase(); return normalized === base || normalized.startsWith(base + '/');
            })) || [...receipts.values()].some(receipt => receipt.config && other.config?.path === receipt.config.path
                && (receipt.config.key === 'plugin' ? sameValue(other.config.value,receipt.config.value) : other.config.key === receipt.config.key))) {
                throw new LocalRecoveryError('different-installation');
            }
        }
    }
    const assertIdentity = async () => {
        if (await projectFolder(projectId) !== root || await projectBindingId(projectId) !== bindingId || await projectInstanceId(projectId) !== instanceId
            || await projectFolder(projectId) !== root) { throw new LocalRecoveryError('different-instance'); }
    };
    await assertIdentity();
    const shared = (key: string): boolean => Object.entries(ledger.roots).some(([ownerKey,value]) => ownerKey !== assetKey(frozen.pkg) && value.packages.some(item => item.key === key));
    return {projectId,root,bindingId,instanceId,plan,receipts,shared,assertIdentity,...frozen};
}
export type RecoveryContext = Awaited<ReturnType<typeof recoveryContext>>;
