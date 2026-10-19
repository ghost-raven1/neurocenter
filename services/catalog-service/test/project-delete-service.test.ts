import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CatalogService} from '../src/catalog/catalog.service';

describe('Ответ удаления проекта после подтверждения транзакции',()=>{
    const project={id:'prj-delete',name:'Проверка'};
    const db={getProject:vi.fn(),deleteProject:vi.fn(),createOperation:vi.fn()};
    const service=Object.assign(Object.create(CatalogService.prototype),{db}) as CatalogService;
    beforeEach(()=>{vi.resetAllMocks();db.getProject.mockResolvedValue(project);db.deleteProject.mockResolvedValue(true);db.createOperation.mockResolvedValue({});});

    it('Передаёт исполнителя в транзакцию и сохраняет прежнюю форму API без второй записи журнала',async()=>{
        expect(await service.deleteProject('Проверка','operator@example.test')).toEqual({ok:true,id:project.id});
        expect(db.deleteProject).toHaveBeenCalledWith(project.id,'operator@example.test');expect(db.createOperation).not.toHaveBeenCalled();
    });
    it('Отказ транзакции не выдаётся за успешное удаление',async()=>{
        db.deleteProject.mockRejectedValue(new Error('Журнал недоступен'));
        await expect(service.deleteProject(project.id,'operator@example.test')).rejects.toThrow('Журнал недоступен');
        expect(db.createOperation).not.toHaveBeenCalled();
    });
    it('Исчезнувший между чтением и блокировкой проект возвращает 404 без операции',async()=>{
        db.deleteProject.mockResolvedValue(false);
        await expect(service.deleteProject(project.id,'operator@example.test')).rejects.toMatchObject({status:404});
        expect(db.createOperation).not.toHaveBeenCalled();
    });
    it('Неизвестный проект возвращает 404 до удаления',async()=>{
        db.getProject.mockResolvedValue(null);
        await expect(service.deleteProject('missing','operator@example.test')).rejects.toMatchObject({status:404});
        expect(db.deleteProject).not.toHaveBeenCalled();expect(db.createOperation).not.toHaveBeenCalled();
    });
});
