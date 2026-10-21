import {createElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AttachmentPreview} from '../src/features/ModelChat/AttachmentPreview';
import {modelChatApi} from '../src/features/ModelChat/api';
import type {IModelChatAttachmentPreview} from '../src/features/ModelChat/types';
const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},state<T>(initial:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(value:T)=>{slot.value=value;}];},effect(effect:()=>void|(()=>void),deps:unknown[]){const index=cursor++,previous=slots[index];if(previous?.deps&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps![i])))return;const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});}};});
const owner=vi.hoisted(()=>({current:'alice'}));
const captureOwner=()=>{const selected=owner.current;return()=>selected===owner.current;};
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useEffect:hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner})}));
vi.mock('../src/features/ModelChat/api',()=>({modelChatApi:{previewAttachment:vi.fn()}}));
vi.mock('antd',()=>({Modal:({children,title}:{children:ReactNode;title:string})=>createElement('dialog',null,title,children),Alert:({message}:{message:string})=>createElement('p',{role:'alert'},message),Spin:({tip}:{tip:string})=>createElement('span',{role:'status'},tip),Typography:{Paragraph:({children}:{children:ReactNode})=>createElement('p',null,children)}}));
const value=():IModelChatAttachmentPreview=>({attachment:{id:'file-one',name:'Private report.md',mediaType:'text/plain',bytes:10,textBytes:10,createdAt:''},text:'<script>danger()</script> private text'});
const close=vi.fn();
const render=(id='file-one')=>{hooks.begin();const node=AttachmentPreview({conversationId:'chat-one',attachmentId:id,onClose:close});hooks.commit();return node as ReactElement<{onCancel:()=>void}>;};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});return{promise,resolve,reject};}
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();owner.current='alice';vi.mocked(modelChatApi.previewAttachment).mockResolvedValue(value());});
afterEach(()=>hooks.dispose());

describe('Предпросмотр личного документа: owner/abort/error',()=>{
    it('До получения показывает загрузку, затем ровно извлечённый inert текст и имя',async()=>{
        expect(renderToStaticMarkup(render())).toContain('Загружаем текст');await flush();const html=renderToStaticMarkup(render());expect(html).toContain('Private report.md');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('не добавляется в базу знаний');
        expect(modelChatApi.previewAttachment).toHaveBeenCalledWith('chat-one','file-one',expect.any(AbortSignal));render().props.onCancel();expect(close).toHaveBeenCalledOnce();
    });
    it('Ошибка загрузки остаётся явной и не изображает пустой успешно распознанный документ',async()=>{
        vi.mocked(modelChatApi.previewAttachment).mockRejectedValueOnce(new Error('Доступ к документу отозван'));render();await flush();const html=renderToStaticMarkup(render());expect(html).toContain('role="alert"');expect(html).toContain('Доступ к документу отозван');expect(html).not.toContain('<pre>');expect(html).not.toContain('Загружаем текст');
    });
    it.each(['resolve','reject']as const)('Смена владельца игнорирует запоздалый %s',async(outcome)=>{
        const pending=deferred<IModelChatAttachmentPreview>();vi.mocked(modelChatApi.previewAttachment).mockReturnValueOnce(pending.promise);render();owner.current='bob';if(outcome==='resolve')pending.resolve(value());else pending.reject(new Error('PRIVATE ERROR'));await flush();const html=renderToStaticMarkup(render());expect(html).not.toContain('private text');expect(html).not.toContain('PRIVATE ERROR');
    });
    it.each(['resolve','reject']as const)('Unmount прерывает read и не применяет поздний %s',async(outcome)=>{
        const pending=deferred<IModelChatAttachmentPreview>();vi.mocked(modelChatApi.previewAttachment).mockReturnValueOnce(pending.promise);render();const signal=vi.mocked(modelChatApi.previewAttachment).mock.calls[0][2];hooks.dispose();expect(signal.aborted).toBe(true);if(outcome==='resolve')pending.resolve(value());else pending.reject(new Error('Aborted request'));await flush();expect(modelChatApi.previewAttachment).toHaveBeenCalledOnce();
    });
    it('Смена attachment scope прерывает старый read до получения следующего',async()=>{
        const pending=deferred<IModelChatAttachmentPreview>();vi.mocked(modelChatApi.previewAttachment).mockReturnValueOnce(pending.promise);render();const signal=vi.mocked(modelChatApi.previewAttachment).mock.calls[0][2];render('file-two');expect(signal.aborted).toBe(true);await flush();pending.resolve({...value(),text:'WRONG OLD DOCUMENT'});await flush();expect(renderToStaticMarkup(render('file-two'))).not.toContain('WRONG OLD DOCUMENT');
    });
});
