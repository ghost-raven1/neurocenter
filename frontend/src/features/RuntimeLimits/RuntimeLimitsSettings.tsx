import {Alert,Button,Card,Collapse,Form,InputNumber,Space,Typography} from 'antd';
import {Link} from 'react-router-dom';
import type {RuntimeLimitPolicy} from '@neurocenter/runtime-limits';
import {useRuntimeLimits} from './useRuntimeLimits';
import {limitFields} from './fields';
import './RuntimeLimits.less';

/** One revisioned policy applies to new operations; accepted work retains its original limits. */
export function RuntimeLimitsSettings():JSX.Element{
    const state=useRuntimeLimits(),locked=state.busy||!!state.pending||!!state.journalError;
    const fields=(group:keyof RuntimeLimitPolicy)=><div className="runtime-limits__grid">{limitFields[group].map(field=>{
        const values=state.draft?.[group]as unknown as Record<string,number>|undefined,ceilings=state.view?.ceilings[group]as unknown as Record<string,number>|undefined;
        return <Form.Item key={field.key} label={field.label} extra={'До '+(ceilings?.[field.key]?.toLocaleString('ru-RU')??'—')+' '+field.unit}>
            <InputNumber aria-label={field.label} value={values?.[field.key]} min={1} max={ceilings?.[field.key]} precision={0} disabled={locked||!state.view?.configurationEnabled}
                addonAfter={field.unit} onChange={value=>state.change(group,field.key,value)} className="runtime-limits__number"/>
        </Form.Item>;
    })}</div>;
    return <Card title="Лимиты операций" extra={<Button loading={state.busy} disabled={!!state.pending} onClick={()=>{void state.read();}}>Перечитать</Button>}>
        <Space direction="vertical" size="middle" className="runtime-limits">
            <Typography.Paragraph type="secondary">Настройки действуют для новых операций. Уже принятые загрузки, ответы и квитанции сохраняют свои ограничения.</Typography.Paragraph>
            {state.error&&<Alert showIcon type="error" message={state.error}/>}
            {state.notice&&<Alert showIcon type="success" message={state.notice}/>}
            {state.view&&!state.view.configurationEnabled&&<Alert showIcon type="info" message="Редактор лимитов выключен. Сохранённая политика и квитанции доступны."/>}
            {state.stale&&!state.pending&&<Alert showIcon type="warning" message="Действующая ревизия изменилась; черновик сохранён." action={<Space wrap><Button size="small" onClick={state.useCurrent}>Взять текущие</Button><Button size="small" onClick={state.keepDraft}>Оставить мой ввод</Button></Space>}/>}
            {state.draft&&<Form layout="vertical"><Collapse defaultActiveKey={['text']}>
                <Collapse.Panel key="text" header="Текстовая база знаний">{fields('textKnowledge')}</Collapse.Panel>
                <Collapse.Panel key="gguf" header="Импорт и хостинг GGUF">{fields('ggufImport')}</Collapse.Panel>
            </Collapse></Form>}
            {state.pending?<Space wrap><Button loading={state.busy} onClick={()=>{void state.receipt();}}>Проверить сохранение</Button><Button disabled={state.busy} onClick={()=>{void state.save();}}>Повторить тот же запрос</Button><Typography.Text type="secondary" copyable>{state.pending.requestKey}</Typography.Text></Space>
                :<Space wrap><Button type="primary" loading={state.busy} disabled={!!state.journalError||!state.dirty||state.stale||!state.view?.configurationEnabled} onClick={()=>{void state.save();}}>Сохранить лимиты</Button><Button disabled={locked||!state.dirty} onClick={state.useCurrent}>Сбросить черновик</Button></Space>}
            <Typography.Paragraph type="secondary">Квоты токенов пользователя и частота запросов настраиваются в карточке модели. Квоты базы знаний, резервные копии и обслуживание — в разделе <Link to="/maintenance">«Обслуживание»</Link>. Базовый резерв токенов, очереди, остальные таймауты и размеры истории ещё имеют отдельные ограничения.</Typography.Paragraph>
        </Space>
    </Card>;
}
