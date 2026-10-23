import {describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {assertProjectChatRoomAccess} from '../src/project-chat/project-chat-room-access';
import {ProjectChatDialogs, canManageProjectChatRoom} from '../src/project-chat/project-chat-dialogs';
import {DEFAULT_PROJECT_CHAT_ROOM, emptyProjectChatRoom, type ProjectChatDb} from '../src/project-chat/project-chat.types';
import type {ProjectChatRepository} from '../src/project-chat/project-chat.repository';
import {allowRequest} from '../src/access/access-policy';
const projectId='prj-rooms', email='creator@example.test', room={...emptyProjectChatRoom(projectId), id:randomUUID(), creator_email:email, visibility:'PRIVATE' as const};
const actor={email,activeRole:'Разработчик',level:2,displayName:'Creator',writable:true};
describe('Project dialogue audience is independent of project administration',()=>{
    it('keeps the legacy public room readable without an invented membership',async()=>{
        const query=vi.fn();await assertProjectChatRoomAccess({query} as ProjectChatDb,emptyProjectChatRoom(projectId),'reader@example.test');expect(query).not.toHaveBeenCalled();
    });
    it('allows its creator and only an explicit current membership, retaining the row fence',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[{email:'invited@example.test'}],rowCount:1});
        await assertProjectChatRoomAccess({query} as ProjectChatDb,room,email);expect(query).not.toHaveBeenCalled();
        await assertProjectChatRoomAccess({query} as ProjectChatDb,room,'invited@example.test');expect(query.mock.calls[0]).toEqual([expect.stringContaining('FOR SHARE'),[projectId,room.id,'invited@example.test']]);
    });
    it.each(['outsider@example.test','main-admin@example.test'])('returns the same 404 for a missing private invitation: %s',async other=>{
        await expect(assertProjectChatRoomAccess({query:vi.fn().mockResolvedValue({rows:[],rowCount:0})} as ProjectChatDb,room,other)).rejects.toHaveProperty('status',404);
    });
    it('never treats a malformed custom audience as public',async()=>{
        await expect(assertProjectChatRoomAccess({query:vi.fn()} as ProjectChatDb,{...room,visibility:undefined},email)).rejects.toHaveProperty('status',404);
    });
    it('lets the creator manage private membership without granting implicit access to admins',()=>{
        expect(canManageProjectChatRoom(room,actor)).toBe(true);
        expect(canManageProjectChatRoom(room,{...actor,email:'admin@example.test',level:4})).toBe(false);
        expect(canManageProjectChatRoom({...room,visibility:'PUBLIC'},{...actor,email:'admin@example.test',level:3})).toBe(true);
        expect(canManageProjectChatRoom({...room,id:DEFAULT_PROJECT_CHAT_ROOM},actor)).toBe(false);
    });
});
describe('Room creation validates the public contract before any transaction',()=>{
    const scoped=vi.fn(), dialogs=new ProjectChatDialogs({scoped} as unknown as ProjectChatRepository);
    it.each([{title:''},{title:'x'.repeat(121)},{title:'line\nline'},{visibility:'hidden'},{visibility:['PRIVATE']},{memberEmails:['not-an-email']},{memberEmails:['person@example.test','PERSON@example.test']},{unexpected:true}])('rejects invalid input %j',async changed=>{
        await expect(dialogs.create(projectId,actor,{requestKey:randomUUID(),title:'Release',visibility:'PRIVATE',memberEmails:[],...changed})).rejects.toHaveProperty('status',400);expect(scoped).not.toHaveBeenCalled();
    });
    it('public is not a misleading subset of project people',async()=>{
        await expect(dialogs.create(projectId,actor,{requestKey:randomUUID(),title:'Release',visibility:'PUBLIC',memberEmails:['person@example.test']})).rejects.toHaveProperty('status',400);
    });
});
describe('Nested room routes preserve the project admission matrix',()=>{
    const claims={email,userRoles:['Разработчик','Наблюдатель','Админ проекта'],projects:[{projectId,projectName:'Rooms',role:'Админ проекта'}],pluginIds:[],skillPaths:[]};
    const base='/api/projects/'+projectId+'/team-chat/rooms', nested=base+'/'+room.id;
    it('observers read rooms but cannot create/post/configure',()=>{
        for(const path of [base,nested,nested+'/history'])expect(allowRequest(claims,'Наблюдатель',{method:'GET',path})).toBe(true);
        for(const path of [base,nested+'/messages'])expect(allowRequest(claims,'Наблюдатель',{method:'POST',path})).toBe(false);
        expect(allowRequest(claims,'Разработчик',{method:'POST',path:base})).toBe(true);expect(allowRequest(claims,'Разработчик',{method:'PUT',path:nested})).toBe(true);
        expect(allowRequest(claims,'Разработчик',{method:'PUT',path:nested+'/participants'})).toBe(true);
    });
    it('undeclared paths and unsafe verbs remain denied',()=>{
        for(const path of [base+'/keys',nested+'/files',nested+'/messages/'+randomUUID()+'/unknown'])expect(allowRequest(claims,'Админ проекта',{method:'GET',path})).toBe(false);
        expect(allowRequest(claims,'Админ проекта',{method:'DELETE',path:nested})).toBe(false);
    });
});
