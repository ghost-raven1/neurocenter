import {beforeEach,describe,expect,it,vi} from 'vitest';
import {RagService} from '../src/rag/rag.service';
import {RagController} from '../src/rag/rag.controller';
import type {ProjectDatabases} from '../src/rag/project-databases';
import type {ISyncChunk} from '../src/rag/dto';

const row={id:'test',filePath:'README.md',content:'Инструкция',contentHash:'server'};
describe('Валидация полной дельты RAG до записи',()=>{
    const applyDelta=vi.fn(async()=>({upserted:1,deleted:0}));const withProject=vi.fn(async(key,action)=>action({applyDelta},key));const service=new RagService({withProject} as unknown as ProjectDatabases);
    beforeEach(()=>{withProject.mockClear();applyDelta.mockClear();});
    it.each([null,{...row,id:''},{...row,content:15},{...row,filePath:{}},{...row,description:[]},{...row,startLine:1.5},{...row,startLine:3,endLine:1},{...row,embedding:[1,2]},{...row,embedding:'[1,2]'},{...row,embedding:Array(2560).fill(null)}])('Некорректный фрагмент не открывает БД: %j',invalid=>{
        return expect(service.applyDelta('project',[invalid] as ISyncChunk[],[])).rejects.toMatchObject({status:400}).then(()=>expect(withProject).not.toHaveBeenCalled());
    });
    it('Повтор ID и конфликт удаления отклоняются до изменения существующей строки',async()=>{
        await expect(service.applyDelta('project',[row,row],[])).rejects.toMatchObject({status:400});await expect(service.applyDelta('project',[row],['test'])).rejects.toMatchObject({status:400});expect(applyDelta).not.toHaveBeenCalled();
    });
    it('Неверные типы массивов и ID удаления не превращаются в пустой успешный пакет',async()=>{
        await expect(service.applyDelta('project',{} as ISyncChunk[],[])).rejects.toMatchObject({status:400});await expect(service.applyDelta('project',[],[null] as unknown as string[])).rejects.toMatchObject({status:400});expect(applyDelta).not.toHaveBeenCalled();
    });
    it('Пустой пакет и nullable-вектор остаются допустимыми',async()=>{
        await expect(service.applyDelta('project',[],[])).resolves.toBeDefined();await expect(service.applyDelta('project',[{...row,embedding:null}],[])).resolves.toBeDefined();
    });
    it.each([1e100,-1e100])('Переполнение float32 не открывает БД: %s',async value=>{
        await expect(service.applyDelta('project',[{...row,embedding:Array(2560).fill(value)}],[])).rejects.toMatchObject({status:400});expect(withProject).not.toHaveBeenCalled();
    });
    it('Граничные конечные значения float32 разрешены',async()=>{
        await expect(service.applyDelta('project',[{...row,embedding:Array(2560).fill(3.4028234663852886e38)}],[])).resolves.toBeDefined();
    });
});
describe('Пагинация RAG',()=>{
    const exportPage=vi.fn(async()=>({chunks:[],rowCount:0,dimension:2560}));const controller=new RagController({exportPage} as unknown as RagService);
    it.each([['1.5','0'],['-1','0'],['NaN','0'],['Infinity','0'],['1','-1'],['1','0.5'],['1','Infinity']])('Неверные limit=%s offset=%s возвращают 400',async(limit,offset)=>{await expect(controller.chunks('project',limit,offset)).rejects.toMatchObject({status:400});});
    it('Применяет целые значения по умолчанию и ограничение размера страницы',async()=>{expect(await controller.chunks('project','3000',undefined)).toMatchObject({limit:2000,offset:0});});
});
