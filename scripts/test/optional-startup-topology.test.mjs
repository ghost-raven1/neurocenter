import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
/** Parse dependency conditions without reading service env files or creating containers. */
export function startupConfiguration(file){
 const result=spawnSync('docker',['compose','--env-file','/dev/null','-f',path.join(root,file),'config','--no-env-resolution','--format','json'],{cwd:root,encoding:'utf8',env:{...process.env,
  NEUROCENTER_CONFIG_DIR:'/tmp/neurocenter-startup-topology',PANEL_URL:'https://fixture.invalid',NEUROCENTER_HOST:'fixture.invalid',NEUROCENTER_RELEASE:'fixture',BOOTSTRAP_ADMIN_EMAIL:'admin@fixture.invalid',
  SSO_HOST:'https://sso.fixture.invalid',SSO_CLIENT_ID:'fixture',REDIRECT_URI:'https://fixture.invalid/auth/callback',TLS_CERT_FILE:'/tmp/neurocenter-startup-topology/cert',TLS_KEY_FILE:'/tmp/neurocenter-startup-topology/key'}});
 assert.equal(result.status,0,'Compose must parse the isolated topology configuration.');return JSON.parse(result.stdout);
}
for(const file of ['docker-compose.yml','compose.production.yml']){
 test(file+': model runtime and business peers cannot prevent the Catalog or Gateway listener from starting',()=>{
  const {services}=startupConfiguration(file);
  assert.equal(services['catalog-service'].depends_on['model-runtime'],undefined);
  assert.deepEqual(services['api-gateway'].depends_on??{},{});
  assert.equal(services['catalog-service'].depends_on.postgres.condition,'service_healthy');
  for(const name of ['api-gateway','oauth2-bridge'])assert.equal(services.frontend.depends_on[name].condition,'service_started');
 });
 test(file+': dependency health diagnostics and per-request capacity policy remain available',()=>{
  const {services}=startupConfiguration(file);assert.ok(services['model-runtime'].healthcheck);assert.ok(services['rag-sync-service'].healthcheck);
  assert.equal(services['feature-flags-service'].depends_on.postgres.condition,'service_healthy');
  assert.equal(services['feature-flags-service'].depends_on['catalog-service'].condition,'service_started');
  if(file==='compose.production.yml')for(const name of ['catalog-service','skills-service','rag-sync-service']){
   assert.equal(services[name].depends_on['capacity-collector'].condition,'service_started');assert.equal(services[name].environment.CAPACITY_REQUIRED,'true');
  }
 });
}
