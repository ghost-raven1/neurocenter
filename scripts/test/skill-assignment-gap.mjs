import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogRequire = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const skillsRequire = createRequire(new URL('../../services/skills-service/package.json', import.meta.url));
const frontendRequire = createRequire(new URL('../../frontend/package.json', import.meta.url));
const {Pool} = catalogRequire('pg');
const {CatalogService} = catalogRequire('./.scenario-audit-dist/catalog/catalog.service.js');
const {CatalogController} = catalogRequire('./.scenario-audit-dist/catalog/catalog.controller.js');
const {SkillsService} = skillsRequire('./.scenario-audit-dist/skills/skills.service.js');
const {FsSkillsStorage} = skillsRequire('./.scenario-audit-dist/storage/fs-skills-storage.js');
const ts = frontendRequire('typescript');
const {build} = frontendRequire('esbuild');
const database = 'nc_skill_assignment_gap_' + randomBytes(8).toString('hex');
const adminUrl = process.env.SKILL_ASSIGNMENT_PG_URL || 'postgresql://rag:rag@127.0.0.1:5432/postgres';
const admin = new Pool({connectionString: adminUrl, max: 2});
const poolErrors = []; admin.on('error', error => poolErrors.push(error.code || error.message));
const originalEnvironment = {...process.env};
const known = JSON.parse(await readFile(path.join(root, 'output/scenario-audit-20261018/catalog/publication-db-red.json'), 'utf8')).beforeDatabases;
const before = (await admin.query('SELECT datname,oid FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
let pool, catalog, storage, temporary, created = false, dropped = false, temporaryRemoved = false, fatal;
const report = {confirmed: false, database, productChanged: false, workingRowsModified: false, networkUsed: false,
    actualPath: 'CatalogController → CatalogService → CatalogDb → ProjectAssetRepository + actual SkillsService/FsSkillsStorage + extracted Store.shown projection'};

// Исполняется настоящий callback useMemo(shown), извлечённый AST из текущего Store.tsx.
const storeSource = await readFile(path.join(root, 'frontend/src/modules/Store/Store.tsx'), 'utf8');
const ast = ts.createSourceFile('Store.tsx', storeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
const walk = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'shown' && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, walk);
};
walk(ast); assert.ok(callback, 'Нужна фактическая Store.shown projection');
const projectionCode = ts.transpileModule('const project = ' + callback + ';', {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const projectCards = new Function('catalog', 'embedded', 'canBrowseCommon', 'isInProject', 'filter', 'installedOnly', 'target', 'search', projectionCode + '\nreturn project();');
const bundled = await build({entryPoints: [path.join(root, 'frontend/src/modules/Store/storeHelpers.ts')], bundle: true, write: false, platform: 'node', format: 'cjs'});
const helpersModule = {exports: {}};
new Function('module', bundled.outputFiles[0].text)(helpersModule);
const {fromSkill, fromPlugin, isToolInProject} = helpersModule.exports;

try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const url = new URL(adminUrl); url.pathname = '/' + database;
    temporary = await mkdtemp(path.join(tmpdir(), 'nc-skill-assignment-gap-'));
    const projectRoot = path.join(temporary, 'project'), skillsRoot = path.join(temporary, 'skills');
    await mkdir(projectRoot); await mkdir(skillsRoot);
    Object.assign(process.env, {CATALOG_PG_URL: url.href, NODE_ENV: 'production', RAG_SERVICE_URL: '', CAPACITY_REQUIRED: 'false'});
    pool = new Pool({connectionString: url.href, max: 2}); pool.on('error', error => poolErrors.push(error.code || error.message));
    catalog = new CatalogService(); await catalog.ensureSchema();
    const projectId = 'prj-skill-assignment-gap';
    await pool.query('INSERT INTO projects(id,name,fs_root_path) VALUES($1,$2,$3)', [projectId, 'Skill assignment own fixture', projectRoot]);
    const actor = {email: 'skill-gap@example.test', activeRole: 'Главный админ'};
    const request = {headers: {'x-bridge-actor': encodeURIComponent(JSON.stringify(actor))}};
    const controller = new CatalogController(catalog, {claims: async () => ({userRoles: ['Главный админ']})});
    storage = new FsSkillsStorage(skillsRoot, entries => catalog.reserveSkillDependencies(entries),
        async events => {await catalog.recordSkillAuditEvents({events});});
    const skills = new SkillsService(storage);
    const body = assetId => ({assetKind: 'skill', assetId});
    const snapshot = async () => {
        const [assets, availableSkills, plugins] = await Promise.all([controller.listProjectAssets(projectId), skills.listSkills({}), catalog.listAiPlugins(1, 100, '')]);
        const availableCatalog = [...plugins.items.map(fromPlugin), ...availableSkills.map(fromSkill)];
        const shown = projectCards(availableCatalog, true, true, app => isToolInProject(app, projectId, assets), 'all', false, projectId, '');
        return {assets, availableSkillPaths: availableSkills.map(item => item.path), renderedCardIds: shown.map(item => item.id)};
    };
    const missingPath = 'common/missing';
    report.missingAssignmentResponse = await controller.addProjectAsset(projectId, body(missingPath), request);
    await controller.addProjectAsset(projectId, body(missingPath), request);
    let missingReadStatus;
    try {await skills.getSkill(missingPath);} catch (error) {missingReadStatus = error.status;}
    assert.equal(missingReadStatus, 404);
    report.missingReadStatus = missingReadStatus;
    report.missingSnapshot = await snapshot();
    assert.equal(report.missingSnapshot.assets.length, 1);
    assert.deepEqual(report.missingSnapshot.renderedCardIds, []);

    const existing = await skills.createSkill({path: 'common', name: 'Удаляемый скилл', slug: 'deleted', meta: {description: 'Собственная проверка удаления'}, body: 'Инструкция собственной fixture'}, actor.email, actor.email);
    assert.equal(existing.path, 'common/deleted');
    report.existingAssignmentResponse = await controller.addProjectAsset(projectId, body(existing.path), request);
    report.beforeDeletion = await snapshot();
    assert.deepEqual(report.beforeDeletion.renderedCardIds, [existing.path]);
    report.skillDeleteResponse = await skills.deleteSkill(existing.path, actor.email);
    report.afterDeletion = await snapshot();
    assert.equal(report.afterDeletion.assets.length, 2);
    assert.deepEqual(report.afterDeletion.availableSkillPaths, []);
    assert.deepEqual(report.afterDeletion.renderedCardIds, []);
    report.explicitApiRemoval = await controller.removeProjectAsset(projectId, body(existing.path), request);
    report.missingApiRemoval = await controller.removeProjectAsset(projectId, body(missingPath), request);
    assert.deepEqual(report.explicitApiRemoval, {ok: true});
    assert.deepEqual(report.missingApiRemoval, {ok: true});
    report.finalAssets = await controller.listProjectAssets(projectId);
    assert.deepEqual(report.finalAssets, []);
    report.projectAssetAudit = (await pool.query("SELECT action,count(*)::int n FROM security_events WHERE action LIKE 'project.asset.%' GROUP BY action ORDER BY action")).rows;
    assert.deepEqual(report.projectAssetAudit, [{action: 'project.asset.add', n: 2}, {action: 'project.asset.remove', n: 2}]);
    report.confirmed = true;
    report.consequence = 'Missing common skill accepted; normal deletion retains project assignment. Store catalog is built only from available tool metadata, so no card or project removal action exists after refresh.';
    report.minimumRecoveryFix = 'Render unavailable project-assignment stubs from raw assets absent from available catalog. Keep original assetKind/assetId, show unavailable reason, allow authorized project-scoped removal with current callback ownership; block install/edit/approval for the stub. Existing DELETE API already removes it safely and audits it.';
    report.consistencyBoundary = 'A preflight skills existence read can reject ordinary nonexistent assignment, but cannot prevent delete-after-read across SQL/FS. Atomic prevention needs coordinated reserve/delete lifecycle or authoritative shared registry; it is unnecessary for restoring a visible removal path and not established by a single remote GET.';
    report.source = ['services/catalog-service/src/catalog/catalog.service.ts:365', 'services/catalog-service/src/catalog/project-asset-repository.ts:42',
        'services/catalog-service/src/catalog/catalog-db.ts:358', 'frontend/src/modules/Store/Store.tsx:154', 'frontend/src/modules/Store/Store.tsx:181', 'frontend/src/modules/Store/Store.tsx:262'];
    report.projection = callback;
} catch (error) {fatal = error.stack || String(error); process.exitCode = 1; console.error(fatal);}
finally {
    await storage?.onModuleDestroy(); await catalog?.onModuleDestroy(); await pool?.end();
    if (created) {await admin.query(`DROP DATABASE "${database}"`); dropped = true;}
    const after = (await admin.query('SELECT datname,oid FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
    const ownSessions = (await admin.query('SELECT pid,state FROM pg_stat_activity WHERE datname=$1', [database])).rows;
    await admin.end();
    if (temporary) {await rm(temporary, {recursive: true, force: true}); temporaryRemoved = true;}
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    const originalDatabasesPreserved = known.every(row => after.some(current => current.datname === row.datname && current.oid === row.oid));
    const ok = !fatal && report.confirmed && dropped && temporaryRemoved && !ownSessions.length && !poolErrors.length && originalDatabasesPreserved;
    await writeFile(path.join(root, 'output/scenario-audit-20261018/catalog/skill-assignment-gap.json'), JSON.stringify({ok, ...report, fatal: fatal || null,
        ownDatabaseDropped: dropped, temporaryRemoved, ownSessions, poolErrors, originalDatabasesPreserved, beforeDatabases: before, afterDatabases: after}, null, 2) + '\n');
    if (!ok) process.exitCode = 1;
    console.log(JSON.stringify({ok, confirmed: report.confirmed, ownDatabaseDropped: dropped, temporaryRemoved, originalDatabasesPreserved}));
}
