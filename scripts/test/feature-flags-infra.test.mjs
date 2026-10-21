import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {applicationServices} from '../production/compose-client.mjs';
import {validateUpdatePlan} from '../production/update.mjs';
import {validateManifest} from '../production/recovery-manifest.mjs';
import {volumeKeys} from '../production/recovery-files.mjs';
import {workspacePackages} from '../workspace/check-plan.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const image='sha256:'+'a'.repeat(64);
const images=()=>Object.fromEntries(applicationServices.map(service=>[service,image]));

/** Разбор топологии Compose не требует env_file сервисов и не создаёт контейнеры. */
function configuration(file) {
    const result=spawnSync('docker',['compose','-f',path.join(root,file),'config','--no-env-resolution','--format','json'],{cwd:root,encoding:'utf8',
        env:{...process.env,NEUROCENTER_CONFIG_DIR:'/tmp/neurocenter-flags-topology',PANEL_URL:'https://fixture.invalid',
            NEUROCENTER_HOST:'fixture.invalid',NEUROCENTER_RELEASE:'fixture',BOOTSTRAP_ADMIN_EMAIL:'admin@fixture.invalid',
            SSO_HOST:'https://sso.fixture.invalid',SSO_CLIENT_ID:'fixture',REDIRECT_URI:'https://fixture.invalid/auth/callback',
            TLS_CERT_FILE:'/tmp/neurocenter-flags-topology/cert',TLS_KEY_FILE:'/tmp/neurocenter-flags-topology/key'}});
    assert.equal(result.status,0,`Compose должен разобрать конфигурацию (status=${result.status}, signal=${result.signal ?? 'none'})`);return JSON.parse(result.stdout);
}

for(const file of ['docker-compose.yml','compose.production.yml'])test(`${file}: сервис флагов внутренний и использует существующий каталог PostgreSQL`,()=>{
    const config=configuration(file),service=config.services['feature-flags-service'];
    assert.equal(service.build.dockerfile,'services/feature-flags-service/Dockerfile');
    assert.equal(service.environment.PORT,'4400');assert.equal(service.environment.CATALOG_SERVICE_URL,'http://catalog-service:4100');
    assert.ok(!service.ports?.length);assert.ok(!service.volumes?.length);
    assert.equal(service.depends_on['catalog-service'].condition,'service_healthy');
    assert.equal(service.depends_on.postgres.condition,'service_healthy');
    assert.equal(config.services['api-gateway'].environment.FEATURE_FLAGS_SERVICE_URL,'http://feature-flags-service:4400');
    assert.equal(config.services['catalog-service'].environment.FEATURE_FLAGS_SERVICE_URL,'http://feature-flags-service:4400');
    assert.ok(!Object.keys(config.services['catalog-service'].depends_on).includes('feature-flags-service'));
    assert.ok(Object.keys(config.services['api-gateway'].depends_on).includes('feature-flags-service'));
    assert.ok(service.healthcheck.test.join(' ').includes('4400/ready'));
    if(file==='compose.production.yml') {
        assert.equal(service.image,'neurocenter/feature-flags-service:fixture');
        assert.equal(service.environment.CATALOG_PG_URL_FILE,'/run/secrets/catalog_url');
        assert.deepEqual(service.secrets.map(secret=>secret.source).sort(),['catalog_url','internal_token','metrics_token']);
        assert.deepEqual(Object.keys(config.volumes).sort(),['backups','capacity','model-weights','postgres','projects','runtime-artifacts','skills']);
    } else assert.ok(new URL(service.environment.CATALOG_PG_URL).pathname==='/catalog');
});

test('Новый сервис входит в установку, сборку, паузу, контроль образов и восстановление',()=>{
    assert.equal(applicationServices.length,7);assert.ok(applicationServices.includes('feature-flags-service'));
    assert.ok(workspacePackages.includes('services/feature-flags-service'));
    assert.deepEqual(volumeKeys,['skills','projects','backups','runtime-artifacts']);
});

test('План семи приложений принимается, старый комплект из шести не подменяет миграцию топологии',()=>{
    const plan={format:'neurocenter-update-v1',id:'feature-flags-fixture',sourceRelease:'old',targetRelease:'new',
        sourceImages:images(),targetImages:images(),postgresImage:image,rollback:'restore-new-project',
        migrationCompatibility:'backward-compatible',rehearsalSha256:'b'.repeat(64),maxPauseMs:60000,catalogMigrations:[{version:0,name:'fixture baseline',checksum:'c'.repeat(64)}]};
    assert.equal(validateUpdatePlan(plan),plan);
    const old=structuredClone(plan);delete old.sourceImages['feature-flags-service'];delete old.targetImages['feature-flags-service'];
    assert.throws(()=>validateUpdatePlan(old),/7 образов/);
    const substituted=structuredClone(plan);delete substituted.targetImages['feature-flags-service'];substituted.targetImages.unknown=image;
    assert.throws(()=>validateUpdatePlan(substituted),/7 образов/);
});

test('Восстановление требует образ флагового сервиса, но новых дампов и серверных томов не требует',()=>{
    const databases=['catalog','rag'].map(name=>({name,owner:name==='catalog'?'nc_catalog':'nc_rag',encoding:'UTF8',collate:'C',ctype:'C',file:'databases/'+name+'.dump'}));
    const manifest={format:'neurocenter-recovery-v2',createdAt:'2026-10-19T00:00:00.000Z',postgresMajor:16,postgresImage:image,images:images(),quiesced:true,databases,
        entries:[...databases.map(database=>({path:database.file,type:'file',mode:0o600,size:1,sha256:'c'.repeat(64)})),
            ...volumeKeys.map(key=>({path:'files/'+key,type:'directory',mode:0o700}))]};
    assert.equal(validateManifest(manifest),manifest);
    const old=structuredClone(manifest);delete old.images['feature-flags-service'];
    assert.throws(()=>validateManifest(old),/feature-flags-service/);
});
