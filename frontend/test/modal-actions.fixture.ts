/** Deterministic hook lifecycle for event-driven SSR component tests without a browser or fake server state. */
export function modalHooks(){
    let cursor=0;const slots:Array<{value?:any;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    return {begin(){cursor=0;},commit(){effects.splice(0).forEach(effect=>effect());},dispose(){slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        state(initial:any){const slot=slots[cursor++]??={value:typeof initial==='function'?initial():initial};return [slot.value,(next:any)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},
        ref(initial:any){return (slots[cursor++]??={value:{current:initial}}).value;},
        effect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(deps&&previous?.deps&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps![i])))return;
            const slot=slots[index]={deps};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},memo(fn:()=>unknown){return fn();}};
}
export type UiNode={kind:string;props:Record<string,any>;text:string};
const words=(value:any):string=>typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(words).join(''):value?.props?words(value.props.children):'';
export function modalUi(){return {nodes:[] as UiNode[],fields:new Map<string,any>(),values:{} as Record<string,any>,form:{} as Record<string,any>,finish:undefined as any,change:undefined as any,failed:undefined as any};}
/** UI doubles retain actual component handlers, disabled states and validators; tests invoke user actions explicitly. */
export function modalAntd(ui:ReturnType<typeof modalUi>,createElement:typeof import('react').createElement){
    const remember=(kind:string,props:Record<string,any>)=>{ui.nodes.push({kind,props,text:words(props.children)});};
    const box=(kind:string,tag='div')=>(props:Record<string,any>)=>{remember(kind,props);return createElement(tag,null,props.children);};
    const Button=(props:Record<string,any>)=>{remember('Button',props);return createElement('button',{disabled:props.disabled},props.children);};
    const Input=Object.assign(box('Input','input'),{TextArea:box('TextArea','textarea'),Search:box('Search','input'),Password:box('Password','input')});
    ui.form={resetFields:()=>{ui.values={};},setFieldsValue:(values:Record<string,any>)=>{Object.assign(ui.values,structuredClone(values));},getFieldsValue:()=>structuredClone(ui.values)};
    const Form=Object.assign((props:Record<string,any>)=>{remember('Form',props);ui.finish=props.onFinish;ui.change=props.onValuesChange;ui.failed=props.onFinishFailed;return createElement('form',null,props.children);},
        {useForm:()=>[ui.form],Item:(props:Record<string,any>)=>{if(props.name)ui.fields.set(String(props.name),props);return createElement('label',null,props.label,props.children,props.help);}});
    const List=Object.assign((props:Record<string,any>)=>createElement('div',null,props.dataSource?.map((row:any,index:number)=>createElement('div',{key:index},props.renderItem(row)))),{Item:box('ListItem')});
    const Empty=Object.assign((props:Record<string,any>)=>createElement('div',null,props.description),{PRESENTED_IMAGE_SIMPLE:'empty'});
    return {Button,Input,Form,List,Empty,Modal:(props:Record<string,any>)=>{remember('Modal',props);return createElement('section',null,props.title,props.children,props.footer);},
        Alert:(props:Record<string,any>)=>{remember('Alert',props);return createElement('div',null,props.message,props.description,props.action);},
        Tabs:(props:Record<string,any>)=>{remember('Tabs',props);return createElement('div',null,props.items?.map((item:any)=>createElement('section',{key:item.key},item.children)));},
        Radio:{Group:box('RadioGroup'),Button:box('RadioButton')},Descriptions:Object.assign(box('Descriptions'),{Item:box('DescriptionItem')}),Timeline:Object.assign(box('Timeline'),{Item:box('TimelineItem')}),
        Space:box('Space'),Checkbox:box('Checkbox'),Select:box('Select'),Tag:box('Tag','span'),Spin:box('Spin'),Typography:{Text:box('Text','span'),Paragraph:box('Paragraph','p'),Link:box('Link','a')},
        Grid:{useBreakpoint:()=>({sm:true})},message:{success:()=>undefined,error:()=>undefined,warning:()=>undefined}};
}
export const flushModal=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
export function deferredModal<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
export function uiNode(ui:ReturnType<typeof modalUi>,kind:string,text?:string){const found=ui.nodes.find(node=>node.kind===kind&&(text===undefined||node.text.includes(text)));if(!found)throw Error('Missing '+kind+': '+text);return found.props;}
