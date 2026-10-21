import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SkillResources} from '../src/modules/Store/publication/SkillResourceEditor';
import type {ISkillResource} from '../src/core/api/interfaces';

type DropProps = {multiple?:boolean;disabled?:boolean;busy?:boolean;onFiles:(files:File[])=>void;onReject:(reason:string)=>void};
type FolderProps = {disabled?:boolean;directory?:boolean;beforeUpload:(file:File, files:File[])=>unknown;children?:ReactNode};
const hooks = vi.hoisted(() => {
    const slots:Array<{value:unknown}> = []; let cursor=0; const cleanups:Array<()=>void> = [];
    return {begin:()=>{cursor=0;}, clear:()=>{slots.length=0;cleanups.length=0;}, dispose:()=>{cleanups.splice(0).forEach(effect=>effect());},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return [slot.value,(value:unknown)=>{slot.value=value;}];},
        useRef:(value:unknown)=>{const slot=slots[cursor++]??={value:{current:value}};return slot.value;},
        useEffect:(effect:()=>()=>void)=>{const slot=slots[cursor++]??={value:false};if(!slot.value){slot.value=true;cleanups.push(effect());}},
    };
});
const ui = vi.hoisted(()=>({drop:undefined as DropProps|undefined,folder:undefined as FolderProps|undefined,error:vi.fn(),changed:vi.fn(),loading:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),...hooks}));
vi.mock('../src/common/components/FileDropZone/FileDropZone',()=>({FileDropZone:(props:DropProps)=>{ui.drop=props;return 'Перетащите ресурсы скилла сюда';}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Button:content,Input:({value}:{value:string})=>value,Space:Object.assign(content,{Compact:content}),Typography:{Text:content},
        Upload:Object.assign((props:FolderProps)=>{ui.folder=props;return props.children;},{LIST_IGNORE:'ignore-fixture-upload'}),message:{error:ui.error}};
});
const existing:ISkillResource={path:'assets/existing.txt',content:'retained'};
let props:{value:ISkillResource[];disabled:boolean;onChange:typeof ui.changed;onLoadingChange:typeof ui.loading};
function render(){hooks.begin();return renderToStaticMarkup(createElement(SkillResources,props));}
const file=(name:string,content='contents',relative=''):File=>({name,size:Buffer.byteLength(content),webkitRelativePath:relative,arrayBuffer:vi.fn(async()=>Uint8Array.from(Buffer.from(content)).buffer)} as unknown as File);
const finish=async()=>{await vi.waitFor(()=>expect(ui.loading).toHaveBeenLastCalledWith(false),{interval:1,timeout:200});};
beforeEach(()=>{hooks.clear();vi.clearAllMocks();props={value:[existing],disabled:false,onChange:ui.changed,onLoadingChange:ui.loading};});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();});

describe('Skill resource drop uses the existing atomic resource draft',()=>{
    it('Accepts a multiple-file batch, preserves existing resources and never posts files to the network',async()=>{
        const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const one=file('one.txt'),two=file('two.bin','\0\u00ff');
        expect(render()).toContain('Перетащите ресурсы');expect(ui.drop).toMatchObject({multiple:true,disabled:false,busy:false});
        ui.drop!.onFiles([one,two]);expect(ui.changed).not.toHaveBeenCalled();expect(ui.loading).toHaveBeenCalledExactlyOnceWith(true);
        await finish();expect(ui.changed).toHaveBeenCalledOnce();const resources=ui.changed.mock.calls[0][0] as ISkillResource[];
        expect(resources[0]).toEqual(existing);expect(resources.map(resource=>resource.path)).toEqual(['assets/existing.txt','assets/one.txt','assets/two.bin']);
        expect(Buffer.from(resources[2].content,'base64')).toEqual(Buffer.from('\0\u00ff'));expect(fetch).not.toHaveBeenCalled();
    });
    it('Retains the explicit folder picker with relative paths and ignores automatic Upload posting',async()=>{
        render();expect(ui.folder).toMatchObject({directory:true,disabled:false});
        const files=[file('SKILL.md','# guide','helper/SKILL.md'),file('guide.md','# resource','helper/references/guide.md'),file('run.py','print(1)','helper/scripts/run.py')];
        for(const item of files)expect(ui.folder!.beforeUpload(item,files)).toBe('ignore-fixture-upload');
        await finish();expect(ui.changed).toHaveBeenCalledOnce();expect(ui.changed.mock.calls[0][0].map((value:ISkillResource)=>value.path)).toEqual(['assets/existing.txt','references/guide.md','scripts/run.py']);
    });
    it('An invalid member rejects the whole batch after a valid file and preserves the existing draft',async()=>{
        render();const large=file('large.bin');Object.defineProperty(large,'size',{value:1024**2+1});
        ui.drop!.onFiles([file('valid.txt'),large]);await finish();expect(ui.changed).not.toHaveBeenCalled();expect(ui.error).toHaveBeenCalledOnce();expect(ui.error.mock.calls[0][0]).toContain('Лимит');expect(render()).toContain(existing.path);
    });
    it('Duplicate paths reject the batch instead of replacing the existing resource',async()=>{
        render();ui.drop!.onFiles([file('EXISTING.txt')]);await finish();expect(ui.changed).not.toHaveBeenCalled();expect(ui.error.mock.calls[0][0]).toContain('конфликтуют');
    });
    it('Blocks a second selection while reading, including a same-frame folder callback',async()=>{
        let release!:(value:ArrayBuffer)=>void;const pending=file('pending.txt');pending.arrayBuffer=vi.fn(()=>new Promise<ArrayBuffer>(resolve=>{release=resolve;}));
        const extra=file('extra.txt');render();ui.drop!.onFiles([pending]);ui.drop!.onFiles([extra]);ui.folder!.beforeUpload(extra,[extra]);
        expect(extra.arrayBuffer).not.toHaveBeenCalled();expect(ui.loading).toHaveBeenCalledOnce();render();expect(ui.drop).toMatchObject({disabled:true,busy:true});
        release(new ArrayBuffer(1));await finish();expect(ui.changed).toHaveBeenCalledOnce();
    });
    it('Retained drop/folder callbacks do not read or report errors once disabled',()=>{
        render();const drop=ui.drop!,folder=ui.folder!,selected=file('must-not-read.txt');props.disabled=true;render();
        drop.onFiles([selected]);folder.beforeUpload(selected,[selected]);drop.onReject('Folder cannot be dropped');
        expect(selected.arrayBuffer).not.toHaveBeenCalled();expect(ui.loading).not.toHaveBeenCalled();expect(ui.error).not.toHaveBeenCalled();expect(ui.drop?.disabled).toBe(true);
    });
    it('Does not publish if the editor becomes disabled before reading completes',async()=>{
        let release!:(value:ArrayBuffer)=>void;const pending=file('pending.txt');pending.arrayBuffer=()=>new Promise<ArrayBuffer>(resolve=>{release=resolve;});
        render();ui.drop!.onFiles([pending]);props.disabled=true;render();release(new ArrayBuffer(1));await finish();expect(ui.changed).not.toHaveBeenCalled();expect(ui.error).not.toHaveBeenCalled();
    });
    it('Does not publish or update loading after unmount, and ignores later retained selections',async()=>{
        let release!:(value:ArrayBuffer)=>void;const pending=file('pending.txt');pending.arrayBuffer=()=>new Promise<ArrayBuffer>(resolve=>{release=resolve;});
        render();const drop=ui.drop!;drop.onFiles([pending]);hooks.dispose();release(new ArrayBuffer(1));await new Promise(resolve=>setTimeout(resolve,10));
        const extra=file('extra.txt');drop.onFiles([extra]);expect(extra.arrayBuffer).not.toHaveBeenCalled();expect(ui.changed).not.toHaveBeenCalled();expect(ui.error).not.toHaveBeenCalled();expect(ui.loading).toHaveBeenCalledExactlyOnceWith(true);
    });
    it('Empty selection is a no-op and a directory rejection leaves the draft intact',()=>{
        render();ui.drop!.onFiles([]);expect(ui.loading).not.toHaveBeenCalled();ui.drop!.onReject('Перетащите файлы, а папку выберите отдельной кнопкой.');
        expect(ui.error).toHaveBeenCalledWith('Перетащите файлы, а папку выберите отдельной кнопкой.');expect(ui.changed).not.toHaveBeenCalled();
    });
});
