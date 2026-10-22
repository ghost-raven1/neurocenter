import {describe,expect,it} from 'vitest';
import {snapshotS3FixtureConfiguration} from './snapshot-s3.fixture';

const fixture={CHAT_S3_ENDPOINT:'http://127.0.0.1:59617',CHAT_S3_REGION:'us-east-1',CHAT_S3_ACCESS_KEY:'synthetic-access',CHAT_S3_SECRET_KEY:'synthetic-secret',CHAT_S3_PROJECT_BUCKET:'qa-project',CHAT_S3_PERSONAL_BUCKET:'qa-personal'};
describe('Snapshot S3 fixture owner boundary',()=>{
    it.each([59617,59627,29001])('accepts the explicitly owned loopback port%s without a session-specific assumption',port=>{
        expect(snapshotS3FixtureConfiguration({...fixture,CHAT_S3_ENDPOINT:'http://127.0.0.1:'+port})).toEqual({endpoint:'http://127.0.0.1:'+port,port,region:'us-east-1',accessKey:'synthetic-access',secretKey:'synthetic-secret'});
    });
    it.each(['http://127.0.0.1:19010','http://127.0.0.1','https://127.0.0.1:59627','http://localhost:59627','http://[::1]:59627','http://remote.invalid:59627','http://private:secret@127.0.0.1:59627','http://127.0.0.1:59627/snapshots','http://127.0.0.1:59627?query=1','http://127.0.0.1:59627#fragment','not-a-url'])('refuses unowned or ambiguous endpoint %s before any I/O',endpoint=>{
        let failure:unknown;try{snapshotS3FixtureConfiguration({...fixture,CHAT_S3_ENDPOINT:endpoint});}catch(error){failure=error;}
        expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private:secret');
    });
    it.each(['CHAT_S3_REGION','CHAT_S3_ACCESS_KEY','CHAT_S3_SECRET_KEY','CHAT_S3_PROJECT_BUCKET','CHAT_S3_PERSONAL_BUCKET'])('requires the explicit integration field %s',field=>{
        for(const value of [undefined,null,'','   ',123])expect(()=>snapshotS3FixtureConfiguration({...fixture,[field]:value})).toThrow('Incomplete explicit');
    });
    it.each([null,undefined,[],{},123])('unknown configuration %j does not acquire any infrastructure defaults',value=>expect(()=>snapshotS3FixtureConfiguration(value)).toThrow());
    it('requires distinct input bucket declarations even though actual cases create their own random buckets',()=>expect(()=>snapshotS3FixtureConfiguration({...fixture,CHAT_S3_PERSONAL_BUCKET:fixture.CHAT_S3_PROJECT_BUCKET})).toThrow('distinct private'));
});
