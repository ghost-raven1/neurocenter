import {describe,expect,it} from 'vitest';
import {requireProjectBackup} from '../src/modules/Projects/features/ProjectBackups/model';
import {parseCatalogBackupResult} from '../src/modules/Maintenance/maintenanceBackup';
const item={id:'backup',projectId:'prj-a',fileName:'project-20261017.dump',sizeBytes:100,createdAt:'2026-10-17T10:00:00Z'};
describe('Подтверждение резервной копии проекта',()=>{
    it('Принимает полный файл выбранного проекта и предупреждение об очистке',()=>{expect(requireProjectBackup({...item,warnings:['Старые копии не удалены.']},'prj-a')).toMatchObject(item);});
    it.each([null,{}, {...item,projectId:'foreign'},{...item,sizeBytes:0},{...item,fileName:'../secret.dump'},{...item,fileName:'partial'},{...item,createdAt:'invalid'},{...item,warnings:[{}]}])('Не объявляет ответ %j созданной копией',value=>{expect(()=>requireProjectBackup(value,'prj-a')).toThrow();});
    it('Предупреждение об очистке не отменяет подтверждённую системную копию',()=>{
        expect(parseCatalogBackupResult({backupAt:item.createdAt,files:[{file:'/copies/test.dump',sizeBytes:10,method:'pg_dump'}],errors:[],warnings:['Проверьте retention']})).toMatchObject({warnings:['Проверьте retention']});
    });
});
