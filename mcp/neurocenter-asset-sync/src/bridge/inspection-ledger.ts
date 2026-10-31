import { assetKey, sameValue } from './installation-receipt.js';
import { packageDependencies } from './install-set.js';
import { canonicalV4, type Package } from './package.js';
import { hash } from './state.js';

interface Ref {
    key: string;
    kind?: string;
    id?: string;
    version: number;
    manifest: string;
    dependencies?: string[];
}
interface Root {
    root: Ref;
    manifest: string;
    packages: Ref[];
    retained?: true;
}
const keyPattern = /^[a-f0-9]{24}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function validRef(item: Ref): boolean {
    return (
        !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        keyPattern.test(item.key) &&
        Number.isSafeInteger(item.version) &&
        item.version > 0 &&
        digestPattern.test(item.manifest) &&
        ((item.kind === undefined && item.id === undefined) ||
            (['skill', 'mcp', 'plugin'].includes(item.kind ?? '') &&
                typeof item.id === 'string' &&
                item.id.length <= 512 &&
                hash(item.kind + ':' + item.id).slice(0, 24) === item.key)) &&
        (item.dependencies === undefined ||
            (Array.isArray(item.dependencies) &&
                item.dependencies.length <= 20 &&
                item.dependencies.every((key) => keyPattern.test(key)) &&
                new Set(item.dependencies).size === item.dependencies.length))
    );
}

/** Реестр читается как данные; проверка никогда не создаёт legacy-записи и не чинит его. */
export function inspectLedger(raw: Buffer, pkg: Package): 'valid' | 'invalid' | 'mismatch' {
    try {
        const data = JSON.parse(raw.toString('utf8')) as { schemaVersion: number; roots: Record<string, Root> };
        if (
            !data ||
            data.schemaVersion !== 1 ||
            !data.roots ||
            typeof data.roots !== 'object' ||
            Array.isArray(data.roots) ||
            Object.keys(data.roots).length > 1000
        ) {
            return 'invalid';
        }
        const target = assetKey(pkg);
        const refs: Ref[] = [];
        const seen = new Map<string, string>();
        for (const [key, root] of Object.entries(data.roots)) {
            if (
                !keyPattern.test(key) ||
                !root ||
                !validRef(root.root) ||
                root.root.key !== key ||
                !digestPattern.test(root.manifest) ||
                (root.retained !== undefined && root.retained !== true) ||
                !Array.isArray(root.packages) ||
                root.packages.length < 1 ||
                root.packages.length > 20 ||
                root.packages.some((item) => !validRef(item)) ||
                new Set(root.packages.map((item) => item.key)).size !== root.packages.length ||
                !root.packages.some(
                    (item) =>
                        item.key === key && item.version === root.root.version && item.manifest === root.root.manifest,
                )
            ) {
                return 'invalid';
            }
            const members = new Map(root.packages.map((item) => [item.key, item]));
            const rootMember = members.get(key)!;
            if (!sameValue(root.root.dependencies ?? [], rootMember.dependencies ?? [])) {
                return 'invalid';
            }
            if (root.retained || root.packages.length === 1) {
                if (root.manifest !== root.root.manifest) {
                    return 'invalid';
                }
            } else {
                if (root.packages.some((item) => !item.kind || !item.id)) {
                    return 'invalid';
                }
                const project = (item: Ref) => ({
                    kind: item.kind,
                    id: item.id,
                    version: item.version,
                    manifest: item.manifest,
                });
                const refs = root.packages.map(project).sort((a, b) => {
                    const left = a.kind + ':' + a.id;
                    const right = b.kind + ':' + b.id;
                    return left === right ? 0 : left < right ? -1 : 1;
                });
                if (
                    root.manifest !==
                    hash(JSON.stringify(canonicalV4({ schemaVersion: 1, root: project(root.root), packages: refs })))
                ) {
                    return 'invalid';
                }
            }
            const visiting = new Set<string>();
            const visited = new Set<string>();
            const visit = (item: Ref): void => {
                if (visiting.has(item.key)) {
                    throw new Error();
                }
                if (visited.has(item.key)) {
                    return;
                }
                visiting.add(item.key);
                for (const dependency of item.dependencies ?? []) {
                    const member = members.get(dependency);
                    if (!member) {
                        throw new Error();
                    }
                    visit(member);
                }
                visiting.delete(item.key);
                visited.add(item.key);
            };
            if (root.packages.some((item) => root.packages.length > 1 && item.dependencies === undefined)) {
                return 'invalid';
            }
            visit(rootMember);
            if (visited.size !== root.packages.length) {
                return 'invalid';
            }
            for (const item of root.packages) {
                const identity = item.version + ':' + item.manifest;
                if (seen.has(item.key) && seen.get(item.key) !== identity) {
                    return 'invalid';
                }
                seen.set(item.key, identity);
                if (item.key === target) {
                    refs.push(item);
                    for (const pin of packageDependencies(pkg)) {
                        const member = members.get(hash(pin.kind + ':' + pin.id).slice(0, 24));
                        if (!member || member.version !== pin.version || member.manifest !== pin.manifest) {
                            return 'mismatch';
                        }
                    }
                }
            }
        }
        const dependencies = packageDependencies(pkg)
            .map((pin) => hash(pin.kind + ':' + pin.id).slice(0, 24))
            .sort();
        if (
            !refs.length ||
            refs.some(
                (item) =>
                    item.version !== pkg.plugin.version ||
                    item.manifest !== pkg.manifest.sha256 ||
                    (item.id !== undefined && (item.id !== pkg.plugin.id || item.kind !== pkg.plugin.kind)) ||
                    !sameValue([...(item.dependencies ?? [])].sort(), dependencies),
            )
        ) {
            return 'mismatch';
        }
        return 'valid';
    } catch {
        return 'invalid';
    }
}
