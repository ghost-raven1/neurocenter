import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {Device} from '../src/devices/device-store';
import {authorizeDeviceLearning} from '../src/learning/device-learning-auth';
import {connection,database,reset,main} from './agent-postgres.fixture';

describe.skipIf(!connection)('Project learning device expiry — actual PostgreSQL clock',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,pool:Pool;
    beforeAll(async()=>{fixture=await database();pool=fixture.pool;await reset(pool);});
    afterAll(async()=>{await fixture?.close();});
    it('rejects expiry during a transaction even while transaction-start now() still allows the token',async()=>{
        const id=randomUUID(),target={projectId:'prj-agents',bindingId:'a'.repeat(64),instanceId:randomUUID()};
        const device={id,email:main.email,role:main.activeRole,report:{bindings:[{...target,valid:true}]}} as Device;
        await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
            [id,device.email,device.role,'Expiry fixture','b'.repeat(64),'c'.repeat(64),JSON.stringify(device.report)]);
        const db=await pool.connect();try{
            await db.query('BEGIN');await db.query("UPDATE bridge_devices SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[id]);
            await db.query('SELECT pg_sleep(0.15)');
            const clocks=(await db.query('SELECT expires_at>now() AS transaction_valid,expires_at>clock_timestamp() AS actual_valid FROM bridge_devices WHERE id=$1',[id])).rows[0];
            expect(clocks).toEqual({transaction_valid:true,actual_valid:false});
            await expect(authorizeDeviceLearning(db,device,target)).rejects.toMatchObject({status:401});
        }finally{await db.query('ROLLBACK');db.release();}
    });
});
