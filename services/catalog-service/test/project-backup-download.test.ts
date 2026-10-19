import {beforeEach,describe,expect,it,vi} from 'vitest';
import {lstat} from 'node:fs/promises';
import {ProjectBackupService} from '../src/backups/project-backup.service';
import type {AccessDb} from '../src/access/access-db';

const mock=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:mock.query,end:vi.fn()})}));
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),lstat:vi.fn()}));
const projectId='prj-backup',good={id:'good',projectId,fileName:'project-good.dump',sizeBytes:100};
const info=(extra={})=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:100,...extra}) as unknown as Awaited<ReturnType<typeof lstat>>;

describe('Независимое скачивание выбранной копии проекта',()=>{
    let service:ProjectBackupService;
    beforeEach(()=>{
        vi.clearAllMocks();vi.mocked(lstat).mockResolvedValue(info());mock.query.mockResolvedValue({rows:[good]});
        service=new ProjectBackupService({projects:async()=>[{id:projectId,name:'Проверка'}]} as unknown as AccessDb);
    });

    it.each(['EACCES','EIO'])('Отказ %s соседней копии не блокирует исправную выбранную',async code=>{
        mock.query.mockImplementation(async(sql:string)=>({rows:sql.includes('id=$2')?[good]:[{...good,id:'bad',fileName:'project-bad.dump'},good]}));
        vi.mocked(lstat).mockImplementation(async filename=>{
            if(String(filename).endsWith('project-bad.dump'))throw Object.assign(new Error('PRIVATE /storage/secret'),{code});
            return info();
        });
        expect(await service.file(projectId,'good')).toMatchObject({name:good.fileName});
        expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('project_id=$1 AND id=$2'),[projectId,'good']);
        expect(lstat).toHaveBeenCalledOnce();
    });

    it('Чужой ID ограничен выбранным проектом до чтения файлов',async()=>{
        mock.query.mockImplementation(async(_sql:string,params:unknown[])=>({rows:params[0]===projectId&&params[1]==='good'?[good]:[]}));
        await expect(service.file(projectId,'foreign')).rejects.toMatchObject({status:404});expect(lstat).not.toHaveBeenCalled();
    });

    it('Несуществующий проект не читает каталог копий и файлы',async()=>{
        await expect(service.file('prj-missing','good')).rejects.toMatchObject({status:404});
        expect(mock.query).not.toHaveBeenCalled();expect(lstat).not.toHaveBeenCalled();
    });

    it('Удалённый файл выбранной копии возвращает 404',async()=>{
        vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('removed'),{code:'ENOENT'}));
        await expect(service.file(projectId,'good')).rejects.toMatchObject({status:404});
    });

    it.each(['../private.dump','project.txt'])('Недопустимое имя %s не читается',async fileName=>{
        mock.query.mockResolvedValue({rows:[{...good,fileName}]});
        await expect(service.file(projectId,'good')).rejects.toMatchObject({status:404});expect(lstat).not.toHaveBeenCalled();
    });

    it.each([{size:99},{nlink:2},{isFile:()=>false},{isSymbolicLink:()=>true}])('Неподтверждённый файл не выдаётся: %j',async change=>{
        vi.mocked(lstat).mockResolvedValue(info(change));
        await expect(service.file(projectId,'good')).rejects.toMatchObject({status:404});
    });

    it.each(['EACCES','EIO'])('Отказ %s выбранного файла остаётся 503 без раскрытия пути',async code=>{
        vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('PRIVATE /storage/secret'),{code}));
        const error=await service.file(projectId,'good').catch(error=>error);
        expect(error).toMatchObject({status:503,response:{code:'BACKUP_STORAGE_UNAVAILABLE'}});expect(JSON.stringify(error)).not.toContain('PRIVATE');
    });
});
