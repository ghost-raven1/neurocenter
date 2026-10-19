import {beforeEach,describe,expect,it,vi} from 'vitest';
import {lstat} from 'node:fs/promises';
import {ProjectBackupService} from '../src/backups/project-backup.service';
import type {AccessDb} from '../src/access/access-db';
const mock=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({query:mock.query,end:vi.fn()})}));
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>(),lstat:vi.fn()}));
const item={id:'fixture-backup',projectId:'prj-fixture',fileName:'project-fixture.dump',sizeBytes:100,createdAt:'2026-10-17T00:00:00Z',databaseName:'fixture'};
const info=(extra={})=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size:100,...extra}) as unknown as Awaited<ReturnType<typeof lstat>>;

describe('Доступность списка резервных копий проекта',()=>{
    let service:ProjectBackupService;
    beforeEach(()=>{
        vi.clearAllMocks();mock.query.mockResolvedValue({rows:[item]});vi.mocked(lstat).mockResolvedValue(info());
        service=new ProjectBackupService({projects:async()=>[{id:'prj-fixture',name:'Проверка'}]} as unknown as AccessDb);
    });
    it('Только обычный файл с подтверждённым размером доступен в списке',async()=>{
        mock.query.mockResolvedValue({rows:[item,{...item,id:'wrong-size'},{...item,id:'hard-link'}]});
        vi.mocked(lstat).mockResolvedValueOnce(info()).mockResolvedValueOnce(info({size:10})).mockResolvedValueOnce(info({nlink:2}));
        expect(await service.list('prj-fixture')).toEqual([item]);
    });
    it('Удалённый файл пропускается, остальные копии остаются доступны',async()=>{
        mock.query.mockResolvedValue({rows:[{...item,id:'removed'},item]});vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('нет файла'),{code:'ENOENT'}));
        expect(await service.list('prj-fixture')).toEqual([item]);
    });
    it.each(['EACCES','EIO'])('Ошибка %s не превращается в ложный пустой список и не раскрывает путь',async code=>{
        vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('/private/storage/secret'),{code}));
        const error=await service.list('prj-fixture').catch(error=>error);
        expect(error).toMatchObject({status:503,response:{code:'BACKUP_STORAGE_UNAVAILABLE'}});expect(JSON.stringify(error)).not.toContain('/private/storage/secret');
    });
});
