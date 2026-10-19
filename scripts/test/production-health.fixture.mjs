import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applicationServices, containers } from '../production/compose-client.mjs';

/** Снимок фиксирует реальные image ID и healthcheck до приёмочных отказов и очистки стека. */
export async function recordProductionHealth(client,directory,name='services-ready') {
    assert.match(name,/^[a-z-]+$/);
    const states=(await containers(client)).filter(item=>applicationServices.includes(item.Config.Labels['com.docker.compose.service']))
        .map(item=>({service:item.Config.Labels['com.docker.compose.service'],project:item.Config.Labels['com.docker.compose.project'],
            containerId:item.Id,imageId:item.Image,image:item.Config.Image,running:item.State.Running,health:item.State.Health?.Status??null})).sort((a,b)=>a.service.localeCompare(b.service));
    assert.equal(states.length,applicationServices.length);
    assert.ok(states.every(item=>item.running&&item.health==='healthy'),'Все шесть приложений должны пройти реальный healthcheck');
    const result={checkedAt:new Date().toISOString(),allSixHealthy:true,services:states};
    await writeFile(path.join(directory,name+'.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
}
