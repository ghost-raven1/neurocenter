import {Button,Form,Select,Typography} from 'antd';
import {packagingPlatformLabels} from './platformLabels';

interface Props {value?:string[];supported:string[];disabled:boolean;error?:string;onChange:(targets?:string[])=>void}

/** Default omission lets the server use every platform supported by the pinned source. */
export function BuildTargetChoice({value,supported,disabled,error,onChange}:Props){
    const options=[...new Set([...supported,...(value??[])])].map(target=>({value:target,label:packagingPlatformLabels[target]||target}));
    return <Form.Item label="Платформы сборки" validateStatus={error?'error':undefined} help={error||undefined}>
        <Select mode="multiple" aria-label="Платформы сборки" value={value??[]} options={options} disabled={disabled}
            placeholder={value===undefined?'Все платформы источника':'Выберите хотя бы одну платформу'} allowClear onChange={onChange}/>
        <Typography.Text type="secondary">{value===undefined?'По умолчанию соберём все поддерживаемые платформы. Можно выбрать только нужный компьютер.':'Соберём только выбранные платформы.'}</Typography.Text>
        {value!==undefined&&<Button type="link" disabled={disabled} onClick={()=>onChange(undefined)}>Все платформы источника</Button>}
    </Form.Item>;
}
