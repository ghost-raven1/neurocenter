import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installBridgeGlobal } from '../src/lib/install.js';

describe('Подключение моста к OpenCode', () => {
    let root: string;
    let config: string;
    beforeEach(async () => {
        root=await mkdtemp(path.join(tmpdir(),'neurocenter-config-'));
        vi.stubEnv('XDG_CONFIG_HOME',root);
        await mkdir(path.join(root,'opencode'));
        config=path.join(root,'opencode','opencode.jsonc');
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); });

    it('Сохраняет комментарии, модель и другие MCP-серверы', async () => {
        await writeFile(config,'// Настройки команды\n{"model":"team/model","mcp":{"existing":{"type":"remote","url":"https://example.test/mcp"}}}\n');
        const result=await installBridgeGlobal();
        const text=await readFile(config,'utf8');
        const data=parse(text);

        expect(text).toContain('// Настройки команды');
        expect(data.model).toBe('team/model');
        expect(data.mcp.existing.url).toBe('https://example.test/mcp');
        expect(data.mcp['neurocenter-asset-sync'].command[1]).toBe(result.indexJs);
        expect(result.indexJs).not.toContain('/lib/index.js');
    });

    it('Повторная установка не дублирует запись и не повреждает JSONC', async () => {
        await writeFile(config,'{"mcp":{}, // Комментарий\n}\n');
        await installBridgeGlobal();
        const before=await readFile(config,'utf8');
        await installBridgeGlobal();
        expect(await readFile(config,'utf8')).toBe(before);
        expect(Object.keys(parse(before).mcp)).toEqual(['neurocenter-asset-sync']);
    });

    it('Не изменяет повреждённую конфигурацию', async () => {
        const invalid='{"mcp": {';
        await writeFile(config,invalid);
        await expect(installBridgeGlobal()).rejects.toThrow('не изменён');
        expect(await readFile(config,'utf8')).toBe(invalid);
    });

    it('Создаёт новый конфиг, когда OpenCode ещё не настроен', async () => {
        const result=await installBridgeGlobal();
        expect(result.created).toBe(true);
        expect(parse(await readFile(result.configPath,'utf8')).mcp['neurocenter-asset-sync'].enabled).toBe(true);
    });

    it('Правит актуальный JSONC после изменения при выборе реального файла',async()=>{
        await writeFile(config,'{"model":"old-model"}\n');
        const realpath=fs.realpath.bind(fs);let changed=false;
        vi.spyOn(fs,'realpath').mockImplementation(async file=>{
            const resolved=await realpath(file);
            if(String(file)===config&&!changed){changed=true;await writeFile(config,'// Новый комментарий\n{"model":"new-model","theme":"new-theme"}\n');}
            return resolved;
        });
        await installBridgeGlobal();
        const saved=await readFile(config,'utf8');expect(changed).toBe(true);
        expect(saved).toContain('// Новый комментарий');expect(parse(saved)).toMatchObject({model:'new-model',theme:'new-theme'});
    });

    it('Изменение после снимка даёт понятный отказ и сохраняет последние пользовательские bytes',async()=>{
        await writeFile(config,'{"model":"old-model"}\n');
        const physical=await fs.realpath(config),stat=fs.stat.bind(fs);let changed=false;
        const latest='// Пользователь сохранил настройки\n{"model":"latest","theme":"light"}\n';
        vi.spyOn(fs,'stat').mockImplementation(async(file,...options)=>{
            const result=await stat(file,...options);
            if([config,physical].includes(String(file))&&!changed){changed=true;await writeFile(config,latest);}
            return result;
        });
        await expect(installBridgeGlobal()).rejects.toThrow('измен');
        expect(changed).toBe(true);expect(await readFile(config,'utf8')).toBe(latest);
        vi.restoreAllMocks();await expect(installBridgeGlobal()).resolves.toMatchObject({created:false});
        expect(parse(await readFile(config,'utf8')).model).toBe('latest');
    });

    it('Сохраняет точную закрытую копию изменяемой конфигурации, повтор не создаёт новых копий',async()=>{
        const original='// Исходный комментарий\n{"model":"team/model"}\n';await writeFile(config,original);
        const result=await installBridgeGlobal();
        expect(result.backupPath).toEqual(expect.any(String));
        expect(await readFile(result.backupPath!,'utf8')).toBe(original);
        if(process.platform!=='win32')expect((await fs.stat(result.backupPath!)).mode&0o777).toBe(0o600);
        const before=(await fs.readdir(path.dirname(config))).sort();
        await installBridgeGlobal();expect((await fs.readdir(path.dirname(config))).sort()).toEqual(before);
    });
    it('Появившийся предпочтительный JSONC не позволяет продолжить замену JSON',async()=>{
        const json=path.join(path.dirname(config),'opencode.json');await writeFile(json,'{"model":"old"}\n');
        const physical=await fs.realpath(json),stat=fs.stat.bind(fs);let created=false;
        vi.spyOn(fs,'stat').mockImplementation(async(file,...options)=>{
            const result=await stat(file,...options);
            if(String(file)===physical&&!created){created=true;await writeFile(config,'// Новый выбранный файл\n{"model":"new"}\n');}
            return result;
        });
        await expect(installBridgeGlobal()).rejects.toThrow('измен');expect(created).toBe(true);
        expect(await readFile(json,'utf8')).toBe('{"model":"old"}\n');expect(await readFile(config,'utf8')).toContain('// Новый выбранный файл');
    });
    it('Сохраняет symlink и режим реального конфига',async()=>{
        const destination=path.join(root,'actual.jsonc');await writeFile(destination,'// Ссылка\n{"model":"linked"}\n',{mode:0o640});
        await fs.symlink(destination,config);
        await installBridgeGlobal();expect((await fs.lstat(config)).isSymbolicLink()).toBe(true);
        expect(parse(await readFile(destination,'utf8')).model).toBe('linked');
        if(process.platform!=='win32')expect((await fs.stat(destination)).mode&0o777).toBe(0o640);
    });
    it('Отказ атомарной публикации сохраняет исходник и его закрытый backup',async()=>{
        const original='// До сбоя\n{"model":"safe"}\n';await writeFile(config,original);
        const destination=await fs.realpath(config),rename=fs.rename.bind(fs);
        vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
            if(String(to)===destination)throw Object.assign(new Error('Disk unavailable'),{code:'EIO'});await rename(from,to);
        });
        await expect(installBridgeGlobal()).rejects.toHaveProperty('code','EIO');expect(await readFile(config,'utf8')).toBe(original);
        const backups=(await fs.readdir(path.dirname(config))).filter(name=>name.endsWith('.bak'));expect(backups).toHaveLength(1);
        expect(await readFile(path.join(path.dirname(config),backups[0]!),'utf8')).toBe(original);
        expect((await fs.readdir(path.dirname(config))).some(name=>name.endsWith('.lock')||name.endsWith('.tmp'))).toBe(false);
        vi.restoreAllMocks();await expect(installBridgeGlobal()).resolves.toMatchObject({created:false});
    });
    it('Новый файл OpenCode в момент публикации не перезаписывается',async()=>{
        const destination=path.join(await fs.realpath(path.dirname(config)),'opencode.json'),link=fs.link.bind(fs);
        const latest='// Создан параллельно\n{"model":"latest"}\n';let created=false;
        vi.spyOn(fs,'link').mockImplementation(async(from,to)=>{
            if(String(to)===destination&&!created){created=true;await writeFile(destination,latest,{flag:'wx'});}
            await link(from,to);
        });
        await expect(installBridgeGlobal()).rejects.toThrow('измен');expect(created).toBe(true);
        expect(await readFile(destination,'utf8')).toBe(latest);
        expect((await fs.readdir(path.dirname(config))).some(name=>name.endsWith('.lock')||name.endsWith('.tmp'))).toBe(false);
    });
    it('Перенаправление symlink после снимка не меняет ни один реальный конфиг',async()=>{
        const first=path.join(root,'first.json'),next=path.join(root,'next.json');
        await writeFile(first,'{"model":"first"}\n');await writeFile(next,'{"model":"next"}\n');await fs.symlink(first,config);
        const physical=await fs.realpath(first),stat=fs.stat.bind(fs);let changed=false;
        vi.spyOn(fs,'stat').mockImplementation(async(file,...options)=>{
            const value=await stat(file,...options);
            if(String(file)===physical&&!changed){changed=true;await fs.unlink(config);await fs.symlink(next,config);}
            return value;
        });
        await expect(installBridgeGlobal()).rejects.toThrow('измен');expect(changed).toBe(true);
        expect(await readFile(first,'utf8')).toBe('{"model":"first"}\n');expect(await readFile(next,'utf8')).toBe('{"model":"next"}\n');
        expect((await fs.lstat(config)).isSymbolicLink()).toBe(true);
    });
    it('Не заменяет один alias конфигурации с жёсткими ссылками',async()=>{
        const original='{"model":"linked"}\n';await writeFile(config,original);const alias=path.join(root,'hardlink.json');await fs.link(config,alias);
        await expect(installBridgeGlobal()).rejects.toThrow('жёстких ссылок');
        expect(await readFile(config,'utf8')).toBe(original);expect(await readFile(alias,'utf8')).toBe(original);
    });
    it('Повторяющиеся mcp не дают ложный успех без фактически подключённого моста',async()=>{
        const original='{"mcp":{},"mcp":{"other":{"type":"remote","url":"https://example.test/mcp"}}}\n';await writeFile(config,original);
        await expect(installBridgeGlobal()).rejects.toThrow('неоднозначные');expect(await readFile(config,'utf8')).toBe(original);
        expect((await fs.readdir(path.dirname(config))).filter(name=>name.endsWith('.bak'))).toEqual([]);
    });
});
