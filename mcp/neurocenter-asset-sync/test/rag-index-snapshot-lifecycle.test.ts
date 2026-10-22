import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {openIndexSnapshot} from '../src/features/rag-index/snapshot.js';

const native=vi.hoisted(()=>({connect:vi.fn()}));
vi.mock('../src/lib/lancedb.js',async original=>({...await original<typeof import('../src/lib/lancedb.js')>(),connectStore:native.connect}));

/** Real directory identity with injectable native-handle failures and observable ownership. */
function handles(){
    const values=[{id:'snapshot-row',content:'retained row',filePath:'README.md',embedding:[0.1,0.2,0.3]}];
    const query={select:vi.fn(),limit:vi.fn(),offset:vi.fn(),filter:vi.fn(),toArrow:vi.fn(async()=>({toArray:()=>values}))};
    for(const operation of ['select','limit','offset','filter'] as const)query[operation].mockReturnValue(query);
    const table={close:vi.fn(),version:vi.fn(async()=>7),checkout:vi.fn(async(_version:number)=>{}),countRows:vi.fn(async()=>1),
        schema:vi.fn(async()=>({fields:[{name:'embedding',type:{listSize:3}}]})),query:vi.fn(()=>query)};
    const db={openTable:vi.fn(async(_name:string)=>table),close:vi.fn()};
    return {db,table};
}

describe('Ownership of a pinned LanceDB snapshot and its short-lived readers',()=>{
    let directory:string,primary:ReturnType<typeof handles>;
    beforeEach(async()=>{
        directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-rag-snapshot-lifecycle-')));
        await fs.mkdir(path.join(directory,'chunks.lance'));
        primary=handles();native.connect.mockReset().mockResolvedValue(primary.db);
    });
    afterEach(async()=>{vi.restoreAllMocks();await fs.rm(directory,{recursive:true,force:true});});

    it.each(['openTable','version','checkout','countRows','schema'] as const)('%s failure closes only the native handles already acquired and preserves its cause',async operation=>{
        const failure=new Error('native '+operation+' unavailable');
        if(operation==='openTable')primary.db.openTable.mockRejectedValueOnce(failure);
        else primary.table[operation].mockRejectedValueOnce(failure);
        await expect(openIndexSnapshot(directory)).rejects.toBe(failure);
        expect(primary.db.close).toHaveBeenCalledTimes(1);
        expect(primary.table.close).toHaveBeenCalledTimes(operation==='openTable'?0:1);
    });

    it('an initialization error remains primary when both cleanup calls fail',async()=>{
        const failure=new Error('native checkout failed');
        primary.table.checkout.mockRejectedValueOnce(failure);
        primary.table.close.mockImplementationOnce(()=>{throw new Error('table cleanup failed');});
        primary.db.close.mockImplementationOnce(()=>{throw new Error('connection cleanup failed');});
        await expect(openIndexSnapshot(directory)).rejects.toBe(failure);
        expect(primary.table.close).toHaveBeenCalledTimes(1);expect(primary.db.close).toHaveBeenCalledTimes(1);
    });

    it('an open failure remains primary when closing its connection also fails',async()=>{
        const failure=new Error('native table unavailable');
        primary.db.openTable.mockRejectedValueOnce(failure);
        primary.db.close.mockImplementationOnce(()=>{throw new Error('connection cleanup failed');});
        await expect(openIndexSnapshot(directory)).rejects.toBe(failure);
        expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).toHaveBeenCalledTimes(1);
    });

    it('a failed connection acquires no table or connection owned by the snapshot',async()=>{
        const failure=new Error('native connection unavailable');native.connect.mockRejectedValueOnce(failure);
        await expect(openIndexSnapshot(directory)).rejects.toBe(failure);
        expect(primary.db.openTable).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();expect(primary.table.close).not.toHaveBeenCalled();
    });

    it('assertCurrent closes a connection whose table cannot be opened without closing the pinned snapshot',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles(),failure=new Error('reader table unavailable');
        native.connect.mockResolvedValueOnce(reader.db);reader.db.openTable.mockRejectedValueOnce(failure);
        try{
            await expect(snapshot.assertCurrent()).rejects.toBe(failure);
            expect(reader.table.close).not.toHaveBeenCalled();expect(reader.db.close).toHaveBeenCalledTimes(1);
            expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();
        }finally{snapshot.close();}
    });

    it('assertCurrent preserves the version error and still closes both reader handles after cleanup failures',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles(),failure=new Error('reader version unavailable');
        native.connect.mockResolvedValueOnce(reader.db);reader.table.version.mockRejectedValueOnce(failure);
        reader.table.close.mockImplementationOnce(()=>{throw new Error('reader table cleanup failed');});
        reader.db.close.mockImplementationOnce(()=>{throw new Error('reader connection cleanup failed');});
        try{
            await expect(snapshot.assertCurrent()).rejects.toBe(failure);
            expect(reader.table.close).toHaveBeenCalledTimes(1);expect(reader.db.close).toHaveBeenCalledTimes(1);
            expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();
        }finally{snapshot.close();}
    });

    it('assertCurrent releases its reader when the native table identity disappears',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles();
        native.connect.mockResolvedValueOnce(reader.db);await fs.rename(path.join(directory,'chunks.lance'),path.join(directory,'replaced.lance'));
        try{
            await expect(snapshot.assertCurrent()).rejects.toMatchObject({code:'ENOENT'});
            expect(reader.table.close).toHaveBeenCalledTimes(1);expect(reader.db.close).toHaveBeenCalledTimes(1);
        }finally{snapshot.close();}
    });

    it('a version mismatch closes only its temporary reader and preserves the pinned handle',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles();native.connect.mockResolvedValueOnce(reader.db);reader.table.version.mockResolvedValueOnce(8);
        try{
            await expect(snapshot.assertCurrent()).rejects.toThrow('Локальный индекс изменился');
            expect(reader.table.close).toHaveBeenCalledTimes(1);expect(reader.db.close).toHaveBeenCalledTimes(1);
            expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();
        }finally{snapshot.close();}
    });

    it('a failed reader connection leaves the already pinned snapshot open',async()=>{
        const snapshot=await openIndexSnapshot(directory),failure=new Error('reader connection unavailable');native.connect.mockRejectedValueOnce(failure);
        try{
            await expect(snapshot.assertCurrent()).rejects.toBe(failure);
            expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();
        }finally{snapshot.close();}
    });

    it('a reader table cleanup failure also closes its connection and reports the first cleanup error',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles(),failure=new Error('reader table cleanup failed');native.connect.mockResolvedValueOnce(reader.db);
        reader.table.close.mockImplementationOnce(()=>{throw failure;});reader.db.close.mockImplementationOnce(()=>{throw new Error('reader connection cleanup failed');});
        try{
            await expect(snapshot.assertCurrent()).rejects.toBe(failure);
            expect(reader.table.close).toHaveBeenCalledTimes(1);expect(reader.db.close).toHaveBeenCalledTimes(1);
        }finally{snapshot.close();}
    });

    it('closing the pinned table always closes its connection and retains the first cleanup error',async()=>{
        const snapshot=await openIndexSnapshot(directory),failure=new Error('pinned table cleanup failed');
        primary.table.close.mockImplementationOnce(()=>{throw failure;});primary.db.close.mockImplementationOnce(()=>{throw new Error('pinned connection cleanup failed');});
        expect(()=>snapshot.close()).toThrow(failure);
        expect(primary.table.close).toHaveBeenCalledTimes(1);expect(primary.db.close).toHaveBeenCalledTimes(1);
    });

    it('healthy reads retain the pinned handles until their owner closes them exactly once',async()=>{
        const snapshot=await openIndexSnapshot(directory),reader=handles();native.connect.mockResolvedValueOnce(reader.db);
        try{
            expect(snapshot).toMatchObject({rowCount:1,dimension:3,version:7});expect(primary.table.checkout).toHaveBeenCalledWith(7);
            const rows=[];for await(const value of snapshot.rows())rows.push(value.id);
            expect(rows).toEqual(['snapshot-row']);expect((await snapshot.selected(['snapshot-row'])).map(row=>row.id)).toEqual(['snapshot-row']);
            await snapshot.assertCurrent();expect(reader.table.close).toHaveBeenCalledTimes(1);expect(reader.db.close).toHaveBeenCalledTimes(1);
            expect(primary.table.close).not.toHaveBeenCalled();expect(primary.db.close).not.toHaveBeenCalled();
        }finally{snapshot.close();}
        expect(primary.table.close).toHaveBeenCalledTimes(1);expect(primary.db.close).toHaveBeenCalledTimes(1);
    });
});
