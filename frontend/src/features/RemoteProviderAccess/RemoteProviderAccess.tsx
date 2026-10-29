import {Alert,Button,Input,Popconfirm,Space,Tag,Typography} from 'antd';
import {usePersonalProviderAccess} from './usePersonalProviderAccess';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {roleLevel} from '../UserBlock/roles';
import './RemoteProviderAccess.less';

/** Read-only recipient settings and a write-only personal key keep team configuration separate. */
export function RemoteProviderAccess({modelId}:{modelId:string}):JSX.Element{
    const user=useSelector((state:RootState)=>state.userBlock.user);
    if(!user||!user.userRoles.includes(user.activeRole)||roleLevel(user.activeRole)<2)return <></>;
    return <PersonalProviderAccess modelId={modelId}/>;
}
function PersonalProviderAccess({modelId}:{modelId:string}):JSX.Element{
    const value=usePersonalProviderAccess(modelId),view=value.view,pending=value.pending;
    const disabled=value.busy||!value.availability.enabled||!!value.journalError;
    return <section className="remote-provider-access" aria-label="Мой доступ к провайдеру">
        <div className="remote-provider-access__heading"><Typography.Text strong>Мой доступ</Typography.Text>
            {view&&<Tag color={view.hasKey?'green':undefined}>{view.hasKey?'Личный ключ сохранён':view.authMode==='required'?'Нужен ваш API-ключ':'Без личного ключа'}</Tag>}</div>
        {!value.availability.enabled&&<Alert showIcon type="info" message={value.availability.reason}/>}
        {value.journalError&&<Alert showIcon type="warning" message={value.journalError}/>}
        {value.error&&<Alert showIcon type="warning" message={value.error}/>}
        {value.notice&&<Typography.Paragraph role="status">{value.notice}</Typography.Paragraph>}
        {view&&<><Typography.Text type="secondary" className="remote-provider-access__recipient">Провайдер: {view.providerUrl}</Typography.Text>
            {view.authMode==='none'?<Typography.Paragraph type="secondary">Этому API ключ не отправляется.</Typography.Paragraph>
                :<><Typography.Paragraph type="secondary">{view.authMode==='required'?'Для запросов используется только ваш API-ключ.':'Ключ необязателен: без него запрос отправляется анонимно.'}</Typography.Paragraph>
                    {!view.canStoreKey&&<Alert showIcon type="warning" message="Хранилище личных ключей не настроено. Обратитесь к администратору."/>}
                    <label htmlFor={`personal-provider-key-${modelId}`}>Мой API-ключ</label><Input.Password id={`personal-provider-key-${modelId}`} value={value.secret}
                        autoComplete="new-password" disabled={value.busy||!!pending&&pending.action==='delete'} placeholder={view.hasKey?'Введите новый ключ для замены':'Введите свой ключ'}
                        onChange={event=>value.setSecret(event.target.value)}/></>}
            {view.legacySharedKeyRetained&&<details><summary>Прежняя настройка</summary><Typography.Text type="secondary">Общий ключ прежней установки сохранён в истории. Новые запросы используют только личный доступ.</Typography.Text></details>}
        </>}
        <Space wrap>
            {pending?<><Button loading={value.busy} onClick={()=>{void value.recover();}}>Проверить сохранение</Button>
                <Button disabled={disabled||pending.action==='save'&&!value.secret} onClick={()=>{void(pending.action==='save'?value.save():value.remove());}}>Повторить прежнюю операцию</Button>
                {value.canRebase&&<Button disabled={disabled} onClick={value.rebase}>Использовать актуальные настройки</Button>}</>
                :<>{view&&view.authMode!=='none'&&<Button type="primary" disabled={disabled||!view.canStoreKey||!value.secret} onClick={()=>{void value.save();}}>Сохранить мой ключ</Button>}
                    {view?.hasKey&&<Popconfirm title="Удалить ваш ключ этого провайдера?" okText="Удалить" cancelText="Отмена" onConfirm={()=>{void value.remove();}}><Button danger disabled={disabled}>Удалить мой ключ</Button></Popconfirm>}
                    <Button size="small" type="link" loading={value.busy} onClick={()=>{void value.read();}}>Обновить сведения</Button></>}
        </Space>
        {pending&&<details><summary>Квитанция операции</summary><Typography.Text code>{pending.requestKey}</Typography.Text></details>}
    </section>;
}
