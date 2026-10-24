import {describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import {CatalogService} from '../src/catalog/catalog.service';
import {ModelsService} from '../src/models/models.service';
import type {IModelActor} from '../src/models/model-access';
import type {IProjectDetail} from '../src/catalog/dto';

function fixture(){
    const project={id:'prj-isolation',name:'isolation',logicalBytes:12,retainedBytes:34,quota:{}} as IProjectDetail;
    const catalog=Object.create(CatalogService.prototype) as CatalogService;
    const getProject=vi.fn(async()=>structuredClone(project));
    const measure=vi.fn(async()=>undefined);
    Object.assign(catalog,{db:{getProject},applyLiveSizes:measure});
    const models=Object.create(ModelsService.prototype) as ModelsService;
    Object.assign(models,{catalog});
    const actor={email:'owner@example.test',activeRole:'Разработчик',claims:{userRoles:['Разработчик'],projects:[{projectId:project.id,projectName:project.name,role:'Разработчик'}]}} as IModelActor;
    return{project,catalog,models,getProject,measure,actor};
}

describe('project identity is independent of optional size measurements',()=>{
    it('resolves model/project access while a public size measurement is still pending',async()=>{
        const f=fixture();let release!:()=>void;
        const pending=new Promise<void>(resolve=>{release=resolve;});
        f.measure.mockImplementation(()=>pending);
        const details=f.catalog.getProject(f.project.id);
        let completed=false;
        const access=f.models.resolveProject({} as Request,f.project.id,2,f.actor).then(value=>{completed=true;return value;});
        try{
            await new Promise(resolve=>setImmediate(resolve));
            expect(completed,'identity must not wait for RAG or filesystem size').toBe(true);
            expect(f.measure).toHaveBeenCalledTimes(1);
        }finally{release();await details;}
        expect((await access).id).toBe(f.project.id);
    });
    it('keeps explicit project detail measurements and their quota values',async()=>{
        const f=fixture();
        f.measure.mockImplementation(async(item?:IProjectDetail)=>{if(item){item.logicalBytes=56;item.retainedBytes=78;}});
        const result=await f.catalog.getProject(f.project.id);
        expect(f.measure).toHaveBeenCalledTimes(1);
        expect(result.quota).toMatchObject({currentBytesUsed:56,retentionBytesUsed:78});
    });
    it('keeps fresh project ACL checks before and after canonical name resolution',async()=>{
        const f=fixture();
        await expect(f.models.resolveProject({} as Request,'prj-other',2,f.actor)).rejects.toMatchObject({status:403});
        expect(f.getProject).not.toHaveBeenCalled();
        f.getProject.mockResolvedValueOnce({...f.project,id:'prj-other'});
        await expect(f.models.resolveProject({} as Request,f.project.name,2,f.actor)).rejects.toMatchObject({status:403});
        expect(f.measure).not.toHaveBeenCalled();
    });
    it('preserves missing-project errors without contacting size dependencies',async()=>{
        const f=fixture();f.getProject.mockResolvedValueOnce(null as unknown as IProjectDetail);
        await expect(f.models.resolveProject({} as Request,f.project.id,2,f.actor)).rejects.toMatchObject({status:404});
        expect(f.measure).not.toHaveBeenCalled();
    });
});
