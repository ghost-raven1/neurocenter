/** Populate only disposable test databases after the canonical migration boundary. */
export async function seedInstallationProjects(pool,projectIds,actor){
    await pool.query('INSERT INTO platform_users(email,is_main_admin,enabled) VALUES($1,true,true) ON CONFLICT(email) DO NOTHING',[actor.email]);
    for(const id of projectIds)await pool.query('INSERT INTO projects(id,name) VALUES($1,$1) ON CONFLICT(id) DO NOTHING',[id]);
}

/** Explicit fixture assignment pins the exact bytes chosen for the following install intent. */
export async function pinInstallationPackage(pool,projectId,pkg,actor){
    await pool.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'assigned',$7)
        ON CONFLICT(project_id,asset_id,asset_kind) DO UPDATE SET asset_version=EXCLUDED.asset_version,
            asset_manifest=EXCLUDED.asset_manifest,pin_origin=EXCLUDED.pin_origin,pin_snapshot=EXCLUDED.pin_snapshot`,
        [projectId,pkg.plugin.id,pkg.plugin.kind,actor.email,pkg.plugin.version,pkg.manifest.sha256,JSON.stringify({card:pkg.plugin,package:pkg})]);
}
