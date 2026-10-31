import { ConflictException } from '@nestjs/common';
import { verifyPackage, type IPackage } from '../catalog/bundle-package';
import {
    installationRef,
    installationSetHash,
    packageDependencies,
    verifyInstallationSet,
    type IInstallationSet,
} from './installation-set';

/** После переноса граф берётся только из сохранённых пакетов текущей привязки. */
export function installedGraph(root: IPackage, installed: IPackage[]): IInstallationSet {
    const selected = new Map<string, IPackage>(),
        visiting = new Set<string>();
    const key = (pkg: IPackage) => pkg.plugin.kind + ':' + pkg.plugin.id;
    const fail = (): never => {
        throw new ConflictException('Закреплённый граф установки повреждён или неполон. Проверьте историю папки.');
    };
    const visit = (pkg: IPackage): void => {
        if (!verifyPackage(pkg) || visiting.has(key(pkg))) return fail();
        const known = selected.get(key(pkg));
        if (known) {
            if (known.manifest.sha256 !== pkg.manifest.sha256) return fail();
            return;
        }
        visiting.add(key(pkg));
        selected.set(key(pkg), pkg);
        if (selected.size > 20) return fail();
        for (const pin of packageDependencies(pkg)) {
            const matches = installed.filter(
                (item) =>
                    item.plugin.id === pin.id &&
                    item.plugin.kind === pin.kind &&
                    item.plugin.version === pin.version &&
                    item.manifest.sha256 === pin.manifest,
            );
            if (matches.length !== 1) return fail();
            visit(matches[0]);
        }
        visiting.delete(key(pkg));
    };
    visit(root);
    const packages = [...selected.values()];
    const set: IInstallationSet = {
        schemaVersion: 1,
        root: installationRef(root),
        packages,
        manifest: installationSetHash(installationRef(root), packages),
    };
    if (!verifyInstallationSet(set)) return fail();
    return set;
}
