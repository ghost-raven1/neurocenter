import type { IPackage } from '../catalog/bundle-package';
import type { IInstallationSet } from './installation-set';

export interface InstallPlanInput { projectId: string; assetKind: string; assetId: string; version: number }
export interface InstallPlanRow {
    id: string; project_id: string; asset_kind: string; asset_id: string; version: number;
    manifest: string; package: IPackage; status: 'pending' | 'approved' | 'revoked';
    revision: number; approved_by: string | null;
    installation_set?: IInstallationSet | null;
}

/** Просмотр точной версии позволяет проверить код до одобрения; локальные секреты сюда не входят. */
export function installPlanView(row: InstallPlanRow) {
    return { id: row.id, projectId: row.project_id, assetKind: row.asset_kind, assetId: row.asset_id,
        version: row.version, manifest: row.manifest, status: row.status, revision: row.revision,
        approvedBy: row.approved_by, config: row.package.config,
        files: row.package.files.map(({ path, size, sha256, encoding, content }) => ({ path, size, sha256, content, ...(encoding ? { encoding } : {}) })),
        requirements: row.package.config?.extra?.requirements ?? { mcp: [], plugins: [] },
        ...(row.installation_set ? { packages: row.installation_set.packages.map(pkg => ({ kind: pkg.plugin.kind, id: pkg.plugin.id,
            name: pkg.plugin.name, version: pkg.plugin.version, manifest: pkg.manifest.sha256,
            files: pkg.files.map(({path,size,sha256,encoding,content}) => ({path,size,sha256,content,...(encoding ? {encoding} : {})})),
            config: pkg.config, requirements: pkg.config?.extra?.requirements ?? {mcp:[],plugins:[]} })) } : {}) };
}
