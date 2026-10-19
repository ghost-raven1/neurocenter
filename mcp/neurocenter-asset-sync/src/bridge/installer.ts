import { projectFolder, projectBindingId } from './workspace.js';
import { verify, type Package } from './package.js';
import { assetBase, assetKey } from './installation-receipt.js';
import { withProjectFiles, commitChanges } from './installation-files.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger } from './installation-ledger.js';
import { planInstall } from './installation-planner.js';
import { packageDependencies, packageRef, sortedRefs, verifyInstallSet, type InstallSet } from './install-set.js';

type Authorize = () => Promise<unknown>;
type Progress = (percent: number, message: string) => Promise<unknown>;

/** Ставит только в явную привязку проекта; чужие файлы и ручные изменения не затирает. */
export async function install(projectId: string, pkg: Package, authorize: Authorize, progress: Progress) {
    verify(pkg);
    if (packageDependencies(pkg).length) { throw new Error('Для зависимостей требуется полный набор установки.'); }
    return installPackages(projectId, [pkg], pkg, pkg.manifest.sha256, authorize, progress, false);
}

/** Весь закреплённый граф получает один lock, одну авторизацию и одну файловую транзакцию. */
export async function installSet(projectId: string, set: InstallSet, authorize: Authorize, progress: Progress) {
    verifyInstallSet(set);
    const root = set.packages.find(pkg => pkg.plugin.kind === set.root.kind && pkg.plugin.id === set.root.id)!;
    return installPackages(projectId, set.packages, root, set.manifest, authorize, progress, true);
}

async function installPackages(projectId: string, packages: Package[], pkg: Package, manifest: string,
    authorize: Authorize, progress: Progress, multiple: boolean) {
    return withProjectFiles(projectId, async root => {
        const plan = new InstallationPlan(root);
        const ledger = await InstallationLedger.load(plan);
        const key = assetKey(pkg);
        const bases = new Set<string>();
        const refs = sortedRefs(packages);
        const ordered = refs.map(ref => packages.find(member => member.plugin.kind === ref.kind && member.plugin.id === ref.id)!);
        for (const member of ordered) {
            const base = assetBase(member).normalize('NFC').toLowerCase();
            if (bases.has(base)) { throw new Error('Конфликт путей разных пакетов набора.'); }
            bases.add(base);
            ledger.assertInstall(key, member);
        }
        for (const member of ordered) { await planInstall(plan, member); }
        await ledger.install(packageRef(pkg), manifest, ordered);
        await progress(35, multiple ? 'Граф зависимостей, конфигурация и локальные файлы проверены' : 'Пакет и локальные файлы проверены');
        await authorize();
        if (await projectFolder(projectId) !== root) {
            throw new Error('Привязка папки изменилась во время установки. Повторите запрос.');
        }
        await plan.verifySnapshot();
        const changes = plan.changes();
        const result = {
            projectId, assetId: pkg.plugin.id, version: pkg.plugin.version,
            bindingId: await projectBindingId(projectId), manifest,
            files: packages.reduce((total, member) => total + member.files.length, 0),
            changed: changes.length > 0,
            ...(multiple ? { packages: refs } : {}),
            readiness: 'unverified',
            note: 'Файлы установлены. OpenCode перечитает конфигурацию при следующем запуске; авторизация внешнего MCP выполняется отдельно.',
        };
        const recoveryPath = await commitChanges(root, changes, { action: 'install', assetKey: key, manifest, result });
        return { ...result, recoveryPath };
    });
}
