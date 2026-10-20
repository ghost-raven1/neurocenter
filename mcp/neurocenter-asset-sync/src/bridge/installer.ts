import {localRagUi} from '../features/rag-ui/contract.js';
import { projectFolder, projectBindingId } from './workspace.js';
import { verify, type Package } from './package.js';
import { assetBase, assetKey } from './installation-receipt.js';
import { withProjectFiles, commitChanges } from './installation-files.js';
import { InstallationPlan } from './installation-plan.js';
import { InstallationLedger } from './installation-ledger.js';
import { planInstall } from './installation-planner.js';
import { CONFIG_PATHS } from './installation-files.js';
import { parse, type ParseError } from 'jsonc-parser';
import { isHostedMcpUrl, requestHostedMcpConnection } from '../features/mcp-host/connect.js';
import { verifyHostedMcpChannel } from '../features/mcp-host/verify.js';
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
        for (const member of ordered) { await planInstall(plan, member, { hostedMcp: (p) => requestHostedMcpConnection(projectId, p) }); }
        await ledger.install(packageRef(pkg), manifest, ordered);
        const hostedChannels = await plannedHostedChannels(plan);
        for (const url of hostedChannels) {
            try { await verifyHostedMcpChannel(url); }
            catch (error) { throw new Error('Не удалось подтвердить хост MCP на площадке: ' + (error as Error).message); }
        }
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
            note: packages.some(member=>{try{return member.plugin.kind==='mcp'&&!!localRagUi(member);}catch{return false;}})
                ? 'Подключение opencode-rag mcp включено. Уже открытый OpenCode перезапустите для перечитывания конфигурации.'
                : hostedChannels.length
                    ? 'Управляемый MCP работает на площадке. OpenCode перечитает конфигурацию при следующем запуске.'
                    : 'Файлы установлены. OpenCode перечитает конфигурацию при следующем запуске; авторизация внешнего MCP выполняется отдельно.',
        };
        const recoveryPath = await commitChanges(root, changes, { action: 'install', assetKey: key, manifest, result });
        return { ...result, recoveryPath };
    });
}

/** Планируемые записи MCP-хоста в снимке конфигурации: проверяются до фиксации файлов. */
async function plannedHostedChannels(plan: InstallationPlan): Promise<string[]> {
    for (const candidate of CONFIG_PATHS) {
        const text = await plan.read(candidate);
        if (text === null) { continue; }
        const errors: ParseError[] = [];
        const parsed = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | null;
        if (errors.length || !parsed || Array.isArray(parsed) || typeof parsed !== 'object') { continue; }
        const entries = (parsed.mcp ?? {}) as Record<string, unknown>;
        if (!entries || Array.isArray(entries) || typeof entries !== 'object') { continue; }
        const urls: string[] = [];
        for (const item of Object.values(entries)) {
            if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'remote'
                && isHostedMcpUrl((item as { url?: unknown }).url)) { urls.push((item as { url: string }).url); }
        }
        return urls;
    }
    return [];
}
