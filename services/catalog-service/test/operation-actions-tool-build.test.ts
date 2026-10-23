import 'reflect-metadata';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import type {IOperation} from '../src/catalog/dto';
import {OperationActionsService} from '../src/operations/operation-actions.service';

const email='owner@operations.fixture',id=randomUUID(),requestKey=randomUUID();
const operation={operationId:'tool-build-'+id,resourceType:'tool-build',resourceId:id,projectId:null,actor:email,state:'RUNNING'} as IOperation;
const request={} as Request;

/** Unit boundary: actual executor receipts and current access, without replacing SQL race acceptance. */
describe('Tool build cancellation from operation history',()=>{
    let job:Record<string,unknown>|undefined,role:string,roles:string[],loseAck:boolean;
    let actions:OperationActionsService,cancel:ReturnType<typeof vi.fn>,query:ReturnType<typeof vi.fn>;
    const receipts=new Map<string,{operation_id:string;action:string;digest:string;target:Record<string,unknown>;result:unknown}>();
    const input=async(key=randomUUID())=>({requestKey:key,expectedDigest:(await actions.decorate(request,operation)).actions!.digest});
    beforeEach(()=>{
        role='Главный админ';roles=['Главный админ'];loseAck=false;receipts.clear();
        job={id,actor:email,request_key:requestKey,state:'RUNNING',publication_started_at:null};
        query=vi.fn(async(sql:string,values:unknown[]=[])=>{
            if(sql.includes('FROM tool_build_jobs'))return{rows:job?[{...job}]:[]};
            if(sql.startsWith('SELECT * FROM operation_action_requests WHERE actor=$1 AND request_key=$2'))return{rows:receipts.has(String(values[1]))?[receipts.get(String(values[1]))]:[]};
            if(sql.startsWith('SELECT * FROM operation_action_requests'))return{rows:[...receipts.values()].filter(row=>row.operation_id===values[1]&&row.action===values[2]&&row.digest===values[3]).slice(0,1)};
            if(sql.startsWith('INSERT INTO operation_action_requests'))receipts.set(String(values[1]),{operation_id:String(values[2]),action:String(values[3]),digest:String(values[4]),target:JSON.parse(String(values[5])),result:values[6]===null?null:JSON.parse(String(values[6]))});
            if(sql.startsWith('UPDATE operation_action_requests')){
                if(loseAck){loseAck=false;throw Error('fixture lost receipt ACK');}
                receipts.get(String(values[1]))!.result=JSON.parse(String(values[2]));
            }
            return{rows:[]};
        });
        const pool={query,connect:async()=>({query,release:vi.fn()})};
        const actor=async()=>({email,activeRole:role,claims:{email,userRoles:roles,projects:[],pluginIds:[],skillPaths:[]}});
        cancel=vi.fn(async()=>{job!.state=job!.state==='QUEUED'?'CANCELLED':'CANCELLING';return{id,requestKey,state:job!.state,message:job!.state==='CANCELLED'?'Stopped before launch':'Stopping owned worker'};});
        actions=new OperationActionsService({getOperation:async()=>operation} as never,{pool,actor} as never,{} as never,{} as never,{cancel} as never,{} as never,{connect:pool.connect} as never);
    });
    it.each(['QUEUED','RUNNING','CANCELLING'])('Offers cancel for the actual %s owned build',async state=>{
        job!.state=state;
        expect((await actions.decorate(request,operation)).actions).toMatchObject({executor:'tool-build',cancel:{supported:true},retry:{supported:false}});
        expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM tool_build_jobs'),[id]);
    });
    it.each(['FAILED','CANCELLED','SUCCEEDED'])('Refuses completed %s build cancellation',async state=>{
        job!.state=state;expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
    });
    it('Uses the authoritative state, actor, request key and publication fence in action CAS',async()=>{
        const first=await input();job!.state='CANCELLING';expect((await input()).expectedDigest).not.toBe(first.expectedDigest);
        job!.state='RUNNING';job!.publication_started_at='2026-10-22T20:00:00Z';const fenced=await input();
        expect(fenced.expectedDigest).not.toBe(first.expectedDigest);expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
        await expect(actions.dispatch(request,operation.operationId,'cancel',first)).rejects.toMatchObject({status:409});expect(cancel).not.toHaveBeenCalled();
        job!.publication_started_at=null;job!.request_key=randomUUID();expect((await input()).expectedDigest).not.toBe(first.expectedDigest);
        job!.request_key=requestKey;job!.actor='other@operations.fixture';expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
    });
    it('Leaves unknown historical and malformed build identities unsupported',async()=>{
        job=undefined;expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
        query.mockClear();expect((await actions.decorate(request,{...operation,resourceId:'old-build'})).actions!.cancel.supported).toBe(false);expect(query).not.toHaveBeenCalled();
    });
    it('Allows only the owner with the currently assigned active main role',async()=>{
        role='Разработчик';roles=['Главный админ','Разработчик'];expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
        role='Главный админ';roles=['Разработчик'];expect((await actions.decorate(request,operation)).actions!.cancel.supported).toBe(false);
        roles=['Главный админ'];expect((await actions.decorate(request,{...operation,actor:'foreign@operations.fixture'})).actions!.cancel.supported).toBe(false);
    });
    it('Delegates to actual cancellation and keeps CANCELLING as RUNNING until the worker is reaped',async()=>{
        const result=await actions.dispatch(request,operation.operationId,'cancel',await input());
        expect(cancel).toHaveBeenCalledWith(expect.objectContaining({email,activeRole:'Главный админ'}),id);
        expect(result).toEqual({operationId:operation.operationId,state:'RUNNING',message:'Stopping owned worker'});
        expect(job!.state).toBe('CANCELLING');
    });
    it('Only an executor receipt confirms cancellation before a queued job launches',async()=>{
        job!.state='QUEUED';expect(await actions.dispatch(request,operation.operationId,'cancel',await input())).toMatchObject({state:'CANCELLED',message:'Stopped before launch'});
    });
    it('A publication race returns the actual retained running receipt instead of fake cancellation',async()=>{
        cancel.mockResolvedValue({id,requestKey,state:'RUNNING',publicationStartedAt:'2026-10-22T20:00:00Z',message:'Publication already started'});
        expect(await actions.dispatch(request,operation.operationId,'cancel',await input())).toMatchObject({state:'RUNNING',message:'Publication already started'});
    });
    it('A lost ACK retries the same executor identity and does not invent terminal cancellation',async()=>{
        const body=await input();loseAck=true;await expect(actions.dispatch(request,operation.operationId,'cancel',body)).rejects.toThrow('lost receipt ACK');
        expect(job!.state).toBe('CANCELLING');expect(await actions.dispatch(request,operation.operationId,'cancel',body)).toMatchObject({state:'RUNNING',message:'Stopping owned worker'});
        expect(cancel).toHaveBeenCalledTimes(2);expect(receipts.get(body.requestKey)?.target).toMatchObject({id,requestKey});
    });
    it('Rechecks current main-admin access even before returning a saved completed operation receipt',async()=>{
        const body=await input();await actions.dispatch(request,operation.operationId,'cancel',body);cancel.mockClear();
        role='Разработчик';roles=['Главный админ','Разработчик'];await expect(actions.dispatch(request,operation.operationId,'cancel',body)).rejects.toMatchObject({status:403});expect(cancel).not.toHaveBeenCalled();
    });
    it('Returns the retained executor receipt for the same authorized action without dispatching twice',async()=>{
        const body=await input(),first=await actions.dispatch(request,operation.operationId,'cancel',body);
        expect(await actions.dispatch(request,operation.operationId,'cancel',body)).toEqual(first);expect(cancel).toHaveBeenCalledOnce();
    });
    it('Rejects an active main role removed from current claims before dispatch',async()=>{
        const body=await input();roles=[];await expect(actions.dispatch(request,operation.operationId,'cancel',body)).rejects.toMatchObject({status:403});expect(cancel).not.toHaveBeenCalled();
    });
    it('Never treats retry as build cancellation',async()=>{
        await expect(actions.dispatch(request,operation.operationId,'retry',await input())).rejects.toMatchObject({status:409});expect(cancel).not.toHaveBeenCalled();
    });
    it.each([{id:randomUUID()},{requestKey:randomUUID()},{state:'UNKNOWN'},{message:undefined}])('Refuses a mismatched or unconfirmed executor receipt %j',async mismatch=>{
        cancel.mockResolvedValue({id,requestKey,state:'CANCELLED',message:'executor receipt',...mismatch} as never);
        await expect(actions.dispatch(request,operation.operationId,'cancel',await input())).rejects.toMatchObject({status:503});
    });
});
