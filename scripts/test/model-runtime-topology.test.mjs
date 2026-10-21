import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const image='ollama/ollama:0.35.1@sha256:292ee7945dfc3d5840a181f3ab86fedb1e66703e02c8af98b50f4da56b7e278c';

/** Разбор топологии Compose не требует env_file сервисов и не создаёт контейнеры. */
function configuration(file) {
    const result=spawnSync('docker',['compose','-f',path.join(root,file),'config','--no-env-resolution','--format','json'],{cwd:root,encoding:'utf8',
        env:{...process.env,NEUROCENTER_CONFIG_DIR:'/tmp/neurocenter-model-topology',PANEL_URL:'https://fixture.invalid',
            NEUROCENTER_HOST:'fixture.invalid',NEUROCENTER_RELEASE:'fixture',BOOTSTRAP_ADMIN_EMAIL:'admin@fixture.invalid',
            SSO_HOST:'https://sso.fixture.invalid',SSO_CLIENT_ID:'fixture',REDIRECT_URI:'https://fixture.invalid/auth/callback',
            TLS_CERT_FILE:'/tmp/neurocenter-model-topology/cert',TLS_KEY_FILE:'/tmp/neurocenter-model-topology/key'}});
    assert.equal(result.status,0,`Compose должен разобрать конфигурацию (status=${result.status}, signal=${result.signal ?? 'none'})`);
    return JSON.parse(result.stdout);
}

for(const file of ['docker-compose.yml','compose.production.yml']) {
    test(`${file}: runtime остаётся внутренним и не получает Docker socket`,()=>{
        const {services}=configuration(file);const runtime=services['model-runtime'],catalog=services['catalog-service'];
        assert.equal(runtime.image,image);assert.ok(!runtime.ports?.length);assert.equal(runtime.environment.OLLAMA_NO_CLOUD,'1');
        assert.equal(runtime.environment.OLLAMA_MAX_LOADED_MODELS,'1');
        assert.equal(catalog.environment.MODEL_RUNTIME_URL,'http://model-runtime:11434');
        assert.equal(catalog.environment.MODEL_STORAGE_PATH,'/data/models');
        assert.equal(catalog.depends_on['model-runtime'].condition,'service_healthy');
        const weights=runtime.volumes.find(mount=>mount.target==='/root/.ollama');
        const probe=catalog.volumes.find(mount=>mount.target==='/data/models');
        assert.equal(weights.source,probe.source);assert.equal(probe.read_only,undefined);
        assert.equal(services['model-volume-init'],undefined);
        assert.ok(!Object.values(services).some(service=>service.volumes?.some(mount=>mount.source?.includes('docker.sock'))));
    });
}

test('Standalone runtime сохраняет loopback и тот же закреплённый образ',()=>{
    const runtime=configuration('compose.embedding.yml').services.embedding;
    assert.equal(runtime.image,image);assert.equal(runtime.ports[0].host_ip,'127.0.0.1');
    assert.equal(runtime.volumes[0].target,'/root/.ollama');
});
