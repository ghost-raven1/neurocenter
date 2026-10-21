import {isValidElement,type ComponentProps,type DragEvent,type ReactElement} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FileDropZone} from '../src/common/components/FileDropZone/FileDropZone';
const hooks=vi.hoisted(()=>{
 let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
 return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},ref:(at:number)=>slots[at].value as {current:unknown},
  useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(value:T)=>{slot.value=value;}];},
  useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
  useEffect(effect:()=>void|(()=>void),deps:unknown[]){const at=cursor++,previous=slots[at];if(previous?.deps?.length===deps.length&&previous.deps.every((value,n)=>Object.is(value,deps[n])))return;const slot=slots[at]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
 };
});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useEffect}));
vi.mock('@ant-design/icons',()=>({UploadOutlined:()=>null}));
vi.mock('antd',()=>({Button:()=>null,Typography:{Text:()=>null}}));
type Props=ComponentProps<typeof FileDropZone>;
let props:Props;
const render=()=>{hooks.begin();const tree=FileDropZone(props);hooks.commit();return tree;};
function child<P>(tree:ReactElement,test:(node:ReactElement<P>)=>boolean):ReactElement<P>{
 for(const node of tree.props.children)if(isValidElement<P>(node)&&test(node))return node;throw Error('Child missing');
}
function drag(files:File[]=[],options:{folder?:boolean;text?:boolean}={}){
 return {preventDefault:vi.fn(),stopPropagation:vi.fn(),dataTransfer:{files,types:options.text?['text/uri-list']:['Files'],items:options.folder?[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true})}]:[],dropEffect:''}} as unknown as DragEvent<HTMLDivElement>;
}
beforeEach(()=>{props={label:'Архив',title:'Перетащите архив',buttonText:'Выбрать архив',accept:'.zip',onFiles:vi.fn(),onReject:vi.fn()};});
afterEach(()=>{hooks.dispose();vi.clearAllMocks();});
it('Picker and drop deliver the identical original File, reset the native input and allow the same file again',()=>{
 const file=new File(['x'],'source.zip'),tree=render(),input=child<{type:string;accept:string;onChange:(event:unknown)=>void}>(tree,node=>node.type==='input');expect(input.props.accept).toBe('.zip');expect(input.props.type).toBe('file');
 const currentTarget={files:[file],value:'source.zip'};input.props.onChange({currentTarget});expect(currentTarget.value).toBe('');input.props.onChange({currentTarget});tree.props.onDrop(drag([file]));
 expect(props.onFiles).toHaveBeenCalledTimes(3);for(const [files]of vi.mocked(props.onFiles).mock.calls)expect(files[0]).toBe(file);
});
it('One-file zones reject the entire multi-file batch, and multiple-file zones retain the complete batch',()=>{
 const files=[new File(['x'],'a.zip'),new File(['y'],'b.zip')];render().props.onDrop(drag(files));expect(props.onFiles).not.toHaveBeenCalled();expect(props.onReject).toHaveBeenCalledWith(expect.stringContaining('один файл'));
 props={...props,multiple:true};render().props.onDrop(drag(files));expect(props.onFiles).toHaveBeenCalledExactlyOnceWith(files);
});
it('A folder mixed with a valid file rejects the whole batch before selection',()=>{
 render().props.onDrop(drag([new File(['x'],'good.zip')],{folder:true}));expect(props.onFiles).not.toHaveBeenCalled();expect(props.onReject).toHaveBeenCalledWith(expect.stringContaining('папку'));
});
it('Text, URLs and empty drops prevent navigation without clearing an existing selection',()=>{
 const tree=render(),event=drag([],{text:true});tree.props.onDrop(event);tree.props.onDrop(drag());expect(event.preventDefault).toHaveBeenCalled();expect(event.stopPropagation).toHaveBeenCalled();expect(props.onFiles).not.toHaveBeenCalled();expect(props.onReject).not.toHaveBeenCalled();
});
it.each(['disabled','busy']as const)('A retained handler cannot bypass current %s, including input and button callbacks',flag=>{
 const tree=render(),input=child<{onChange:(event:unknown)=>void}>(tree,node=>node.type==='input'),button=child<{onClick:()=>void}>(tree,node=>typeof node.props.onClick==='function'),click=vi.fn();hooks.ref(0).current={click};
 props={...props,[flag]:true};render();const event=drag([new File(['x'],'a.zip')]);tree.props.onDrop(event);input.props.onChange({currentTarget:{files:event.dataTransfer.files,value:'a.zip'}});button.props.onClick();expect(event.preventDefault).toHaveBeenCalled();expect(props.onFiles).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
});
it('Nested drag enter/leave stays active until the last leave; blocking clears it',()=>{
 let tree=render();tree.props.onDragEnter(drag());tree=render();tree.props.onDragEnter(drag());tree.props.onDragLeave(drag());expect(render().props.className).toContain('--active');render().props.onDragLeave(drag());expect(render().props.className).not.toContain('--active');
 render().props.onDragEnter(drag());props={...props,disabled:true};render();props={...props,disabled:false};expect(render().props.className).not.toContain('--active');
});
it('Unmounted controls cannot select or open a chooser',()=>{
 const tree=render(),button=child<{onClick:()=>void}>(tree,node=>typeof node.props.onClick==='function'),click=vi.fn();hooks.ref(0).current={click};hooks.dispose();tree.props.onDrop(drag([new File(['x'],'a.zip')]));button.props.onClick();expect(props.onFiles).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
});
