import './feature-flags-enabled';
import {createElement,type ComponentProps,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FileDropZone} from '../src/common/components/FileDropZone/FileDropZone';
import {AssetArchiveModal} from '../src/features/AssetSources/AssetArchiveModal';
import type {useAssetArchiveUpload} from '../src/features/AssetSources/useAssetArchiveUpload';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[]}>=[],effects:Array<()=>void>=[];
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.length=0;effects.length=0;},
        useState:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return [slot.value,(value:unknown)=>{slot.value=value;}];},
        useEffect:(effect:()=>void,deps:unknown[])=>{const index=cursor++,previous=slots[index];if(previous&&previous.deps?.every((value,n)=>Object.is(value,deps[n])))return;slots[index]={deps};effects.push(effect);},
    };
});
const ui=vi.hoisted(()=>({drop:undefined as undefined|ComponentProps<typeof FileDropZone>,modal:undefined as undefined|{onOk:()=>void;onCancel:()=>void;okButtonProps:{disabled?:boolean};cancelText:string},close:vi.fn(),upload:vi.fn(),cancel:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),...hooks}));
vi.mock('../src/common/components/FileDropZone/FileDropZone',()=>({FileDropZone:(props:ComponentProps<typeof FileDropZone>)=>{ui.drop=props;return null;}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return{Modal:(props:NonNullable<typeof ui.modal>&{children:ReactNode})=>{ui.modal=props;return props.children;},Space:content,Typography:{Paragraph:content,Text:content},Alert:({message}:{message:string})=>message,Progress:({percent}:{percent:number})=>String(percent)};
});
let flow:ReturnType<typeof useAssetArchiveUpload>;
function render(open=true,blocked=false){hooks.begin();const html=renderToStaticMarkup(createElement(AssetArchiveModal,{open,blocked,upload:flow,onClose:ui.close}));hooks.commit();return html;}
beforeEach(()=>{vi.clearAllMocks();flow={stage:'idle',percent:0,error:'',busy:false,upload:ui.upload,cancel:ui.cancel};});
afterEach(()=>hooks.dispose());

it('Объясняет Download ZIP и подготовленную поставку, выбирает один File без multipart',()=>{
    const html=render();expect(html).toContain('Download ZIP');expect(html).toContain('сетевой дозагрузки нет');expect(html).toContain('8 ГиБ');expect(ui.drop?.accept).toBe('.zip,.tar,.tar.gz,.tgz');expect(ui.modal?.okButtonProps.disabled).toBe(true);
    const file=new File(['zip'],'source.zip');ui.drop!.onFiles([file]);const selected=render();expect(selected).toContain('source.zip');expect(ui.modal?.okButtonProps.disabled).toBe(false);ui.modal!.onOk();expect(ui.upload).toHaveBeenCalledExactlyOnceWith(file);expect(ui.close).not.toHaveBeenCalled();
});
it('Ошибка drop или неверный формат сохраняет прежний файл, но блокирует его отправку до нового выбора',()=>{
    const file=new File(['x'],'one.zip');render();ui.drop!.onFiles([file]);render();
    ui.drop!.onReject('Выберите один файл за одну загрузку.');expect(render()).toContain('Выберите один файл');expect(ui.modal?.okButtonProps.disabled).toBe(true);ui.modal!.onOk();expect(ui.upload).not.toHaveBeenCalled();
    ui.drop!.onFiles([new File(['x'],'bad.txt')]);expect(render()).toContain('Выберите архив');expect(ui.modal?.okButtonProps.disabled).toBe(true);ui.modal!.onOk();expect(ui.upload).not.toHaveBeenCalled();
    ui.drop!.onFiles([file]);render();expect(ui.modal?.okButtonProps.disabled).toBe(false);ui.modal!.onOk();expect(ui.upload).toHaveBeenCalledExactlyOnceWith(file);
});
it('Закрытие сбрасывает выбранный File, повторное открытие требует нового выбора',()=>{
    render();ui.drop!.onFiles([new File(['x'],'one.zip')]);render();ui.modal!.onCancel();expect(ui.cancel).toHaveBeenCalledOnce();expect(ui.close).toHaveBeenCalledOnce();render(false);render(true);expect(ui.modal?.okButtonProps.disabled).toBe(true);
});
it.each(['uploading','validating']as const)('Передача/проверка %s показывает статус и допускает отмену, блокируя новый выбор',stage=>{
    flow={...flow,stage,busy:true,percent:stage==='validating'?100:32};const html=render();expect((ui.drop?.disabled||ui.drop?.busy)).toBe(true);expect(ui.modal?.cancelText).toBe('Отменить загрузку');expect(html).toContain(stage==='validating'?'Сервер проверяет':'Загружаем архив');ui.modal!.onCancel();expect(ui.cancel).toHaveBeenCalledOnce();
});
it('Блокировка активным импортом/редактором не отправляет уже выбранный файл',()=>{
    render();ui.drop!.onFiles([new File(['x'],'one.zip')]);render(true,true);expect(ui.modal?.okButtonProps.disabled).toBe(true);expect((ui.drop?.disabled||ui.drop?.busy)).toBe(true);ui.modal!.onOk();expect(ui.upload).not.toHaveBeenCalled();
});
it('Выводит ошибку сервера для повторной загрузки',()=>{
    flow={...flow,error:'Превышен серверный лимит архива'};expect(render()).toContain('Превышен серверный лимит архива');
});

it('Выбранная поставка показывает размер и отличает её от исходников инструмента',()=>{
    render();ui.drop!.onFiles([new File([new Uint8Array(2_000_000)],'supply.tar')]);const html=render();
    expect(html).toContain('2.0 МБ');expect(html).toContain('Упаковать инструмент');expect(html).toContain('исходниками');
});
