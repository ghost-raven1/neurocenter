import {isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {SourceArchiveUploader} from '../src/modules/Store/packaging/SourceArchiveUploader';
import {SourceFilesPicker} from '../src/modules/Store/packaging/SourceFilesPicker';
import type {useSourceUpload} from '../src/modules/Store/packaging/useSourceUpload';

const hooks=vi.hoisted(()=>{
 let cursor=0;const slots:Array<{value:unknown}>=[];
 return {begin:()=>{cursor=0;},dispose:()=>{slots.length=0;},
  useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(value:unknown)=>{slot.value=value;}];},
  useRef:(initial:unknown)=>{const slot=slots[cursor++]??={value:{current:initial}};return slot.value;},
 };
});
interface ZoneProps {label:string;disabled?:boolean;busy?:boolean;accept?:string;buttonText:string;onFiles:(files:File[])=>void;onReject:(message:string)=>void}
interface NativeInput {disabled?:boolean;onChange:(event:{currentTarget:{files:File[];value:string}})=>void}
const ui=vi.hoisted(()=>({zone:undefined as ZoneProps|undefined,inputs:[] as NativeInput[],select:vi.fn(),entry:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef}));
vi.mock('../src/common/components/FileDropZone/FileDropZone',()=>({FileDropZone:(props:ZoneProps)=>{ui.zone=props;return props.label;}}));
vi.mock('@ant-design/icons',()=>({FileZipOutlined:()=>null,FolderOpenOutlined:()=>null,UploadOutlined:()=>null}));
vi.mock('../src/modules/Store/packaging/SourceEntrypointChoice',()=>({SourceEntrypointChoice:()=>null}));
vi.mock('antd',()=>{
 const content=({children}:{children?:ReactNode})=>children;
 return {Alert:({message}:{message:string})=>message,Button:content,Divider:content,Space:content,Tag:content,Progress:()=>null,Typography:{Text:content,Paragraph:content}};
});
let upload:ReturnType<typeof useSourceUpload>;
const visit=(node:ReactNode):void=>{
 if(Array.isArray(node))node.forEach(visit);
 else if(isValidElement<NativeInput&{children?:ReactNode}>(node)){if(node.type==='input')ui.inputs.push(node.props);visit(node.props.children);}
};
function mcp(disabled=false){hooks.begin();return renderToStaticMarkup(SourceArchiveUploader({upload,disabled,entrypoint:'bin/server',onEntrypointChange:ui.entry}));}
function source(disabled=false,reading=false){hooks.begin();ui.inputs=[];const tree=SourceFilesPicker({disabled,reading,archiveName:'selected.zip',uploaded:{files:[{path:'index.ts',content:'1'}],rootName:'tool',skipped:0},onSelect:ui.select});visit(tree);return renderToStaticMarkup(tree);}
beforeEach(()=>{
 hooks.dispose();vi.clearAllMocks();ui.zone=undefined;ui.inputs=[];
 upload={scope:'fixture',phase:'ready',percent:100,error:'',busy:false,blocked:false,
  upload:{id:'upload',requestKey:'request',name:'ready.tgz',bytes:100,sha256:'a'.repeat(64),state:'READY',expiresAt:'2027-01-01',metadata:{candidates:['bin/server'],entrypoint:'bin/server',requiresEntrypointChoice:false,runnableKinds:['mcp'],choices:[{entrypoint:'bin/server',adapter:'native',targets:['linux-x64']}] }},
  select:ui.select,cancel:vi.fn(),recheck:vi.fn(),forget:vi.fn(),restore:vi.fn(),retryRecovery:vi.fn()};
});
afterEach(()=>hooks.dispose());

describe('Packaging drop zones use the existing source flows',()=>{
 it('One MCP archive or executable reaches the durable upload without starting a build',()=>{
  const file=new File(['binary'],'server');mcp();expect(ui.zone?.label).toBe('Архив MCP');expect(ui.zone?.accept).toBeUndefined();
  ui.zone!.onFiles([file]);expect(ui.select).toHaveBeenCalledExactlyOnceWith(file);expect(ui.entry).toHaveBeenCalledExactlyOnceWith('');
 });
 it.each(['disabled','busy','blocked']as const)('MCP %s refuses both a current and a retained selection handler',lock=>{
  mcp();const previous=ui.zone!;upload={...upload,busy:lock==='busy',blocked:lock==='blocked'};mcp(lock==='disabled');expect(ui.zone?.disabled).toBe(true);
  previous.onFiles([new File(['x'],'old.zip')]);ui.zone!.onFiles([new File(['x'],'new.zip')]);previous.onReject('stale rejection');expect(ui.select).not.toHaveBeenCalled();expect(ui.entry).not.toHaveBeenCalled();expect(mcp(lock==='disabled')).not.toContain('stale rejection');
 });
 it('A rejected MCP drop retains the verified upload and entrypoint, and the next valid selection clears its error',()=>{
  mcp();ui.zone!.onReject('Выберите один файл за одну загрузку.');const html=mcp();expect(html).toContain('Выберите один файл');expect(html).toContain('ready.tgz');expect(html).toContain('SHA-256 проверена');expect(ui.entry).not.toHaveBeenCalled();expect(ui.select).not.toHaveBeenCalled();
  ui.zone!.onFiles([new File(['new'],'next.tgz')]);expect(mcp()).not.toContain('Выберите один файл');
 });
 it('An empty or malformed multi-file callback does not silently select the first MCP file',()=>{
  mcp();ui.zone!.onFiles([]);ui.zone!.onFiles([new File(['x'],'one.zip'),new File(['x'],'two.zip')]);expect(ui.select).not.toHaveBeenCalled();expect(ui.entry).not.toHaveBeenCalled();
 });
 it('An archive drop invokes the same source parser once and keeps separate folder/file choices',()=>{
  const html=source(),file=new File(['zip'],'source.zip');expect(html).toContain('Выбрать папку');expect(html).toContain('Выбрать файлы');expect(ui.inputs).toHaveLength(2);expect(ui.zone?.accept).toBe('.zip,.tar,.tar.gz,.tgz');
  ui.zone!.onFiles([file]);expect(ui.select).toHaveBeenCalledExactlyOnceWith([file],true);
 });
 it.each(['disabled','reading']as const)('Source %s blocks current and retained drops and native picker events',lock=>{
  source();const previous=ui.zone!,input=ui.inputs[0];source(lock==='disabled',lock==='reading');expect(ui.zone?.disabled).toBe(true);expect(ui.inputs.every(input=>input.disabled)).toBe(true);
  const file=new File(['x'],'source.zip'),event={currentTarget:{files:[file],value:'source.zip'}};previous.onFiles([file]);ui.zone!.onFiles([file]);input.onChange(event);expect(event.currentTarget.value).toBe('');expect(ui.select).not.toHaveBeenCalled();
 });
 it('Source rejection retains the previous files and a valid native selection clears only that error',()=>{
  source();ui.zone!.onReject('Перетащите файлы, а папку выберите отдельной кнопкой.');const html=source();expect(html).toContain('Перетащите файлы');expect(html).toContain('selected.zip');expect(ui.select).not.toHaveBeenCalled();
  const file=new File(['code'],'index.ts'),event={currentTarget:{files:[file],value:'index.ts'}};ui.inputs[1].onChange(event);expect(event.currentTarget.value).toBe('');expect(ui.select).toHaveBeenCalledExactlyOnceWith([file],false);expect(source()).not.toContain('Перетащите файлы');
 });
});
