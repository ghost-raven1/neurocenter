import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {syncSkills} from '../src/tools/sync-skills.js';
import {writeState} from '../src/bridge/state.js';

describe('Неполный локальный скан не очищает серверный каталог скиллов',()=>{
    let root:string;const fetchMock=vi.fn(async()=>Response.json({upserted:1,removed:2}));
    beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-skill-scan-'));vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(root,'private'));vi.stubGlobal('fetch',fetchMock);fetchMock.mockClear();await writeState('credentials',{token:'fixture',deviceId:'test',email:'test@example.test'});await fs.mkdir(path.join(root,'.opencode/skills/valid'),{recursive:true});await fs.writeFile(path.join(root,'.opencode/skills/valid/SKILL.md'),'---\nname: helper\n---\nИнструкция');});
    afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
    it('Ошибка чтения одной карточки блокирует отправку всего снимка',async()=>{
        await fs.mkdir(path.join(root,'.opencode/skills/broken'));await fs.writeFile(path.join(root,'.opencode/skills/broken/SKILL.md'),'Нет YAML-заголовка');const result=await syncSkills({root,projectKey:'project'}) as {ok:boolean};expect(result.ok).toBe(false);expect(fetchMock).not.toHaveBeenCalled();
    });
    it('Достигнутая глубина обхода не считается полным снимком',async()=>{
        const nested=path.join(root,'.opencode/skills/a/b/c/d/e/f/g');await fs.mkdir(nested,{recursive:true});await fs.writeFile(path.join(nested,'SKILL.md'),'---\nname: deep\n---\nИнструкция');const result=await syncSkills({root,projectKey:'project'}) as {ok:boolean};expect(result.ok).toBe(false);expect(fetchMock).not.toHaveBeenCalled();
    });
    it('Пропущенная символьная ссылка не превращается в удаление серверной карточки', async()=>{
        await fs.symlink(path.join(root,'.opencode/skills/valid'),path.join(root,'.opencode/skills/linked'));
        const result=await syncSkills({root,projectKey:'project'}) as {ok:boolean};expect(result.ok).toBe(false);expect(fetchMock).not.toHaveBeenCalled();
    });
});
