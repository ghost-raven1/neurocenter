import {Alert,Button,Descriptions,Space,Spin,Tag,Typography} from 'antd';
import {requestStates,requestTime} from './presentation';
import type {IRequestDetail} from './types';

interface IProps {latest:IRequestDetail|null;loading:boolean;error:string;draft:string;disabled:boolean;onRefresh:()=>void;onUseLatest:()=>void}

/** A current server version is shown for comparison; choosing it never replaces the user's draft. */
export function RequestEditConflict({latest,loading,error,draft,disabled,onRefresh,onUseLatest}:IProps):JSX.Element {
    return <div className="catalog-requests__edit-conflict">
        <Alert showIcon type="warning" message="Заявка изменилась" description="Ваши поля сохранены. Сравните их с актуальной заявкой перед повторным сохранением."/>
        <Space wrap><Button loading={loading} disabled={disabled} onClick={onRefresh}>Обновить актуальную заявку</Button>{latest&&<Tag color={requestStates[latest.status].color}>{requestStates[latest.status].label} · версия {latest.revision}</Tag>}</Space>
        {loading&&<Spin tip="Проверяем актуальную заявку…"/>}
        {error&&<Alert role="alert" type="error" showIcon message="Не удалось проверить актуальную заявку" description={error}/>}
        {latest&&<>
            <Typography.Title level={5}>Сейчас на сервере</Typography.Title>
            <Descriptions column={1} size="small">
                <Descriptions.Item label="Название">{latest.title}</Descriptions.Item>
                <Descriptions.Item label="Описание"><Typography.Paragraph className="catalog-requests__text">{latest.description}</Typography.Paragraph></Descriptions.Item>
                {latest.sourceUrl&&<Descriptions.Item label="Источник">{latest.sourceUrl}</Descriptions.Item>}
                {latest.target&&<Descriptions.Item label="Карточка">{latest.target.name} · v{latest.target.version}</Descriptions.Item>}
                <Descriptions.Item label="Обновлена">{requestTime(latest.updatedAt)}</Descriptions.Item>
            </Descriptions>
            {latest.permissions.canEdit
                ?<><Typography.Paragraph type="secondary">Выбор версии сохраняет ваши поля. Затем нажмите «Сохранить изменения».</Typography.Paragraph><Button disabled={disabled||loading||!!error} onClick={onUseLatest}>Использовать актуальную версию {latest.revision}</Button></>
                :<Alert showIcon type="info" message="Сейчас редактирование недоступно" description="Статус или права изменились. Повторное сохранение заблокировано; ваш текст остаётся в черновике и доступен для копирования."/>}
        </>}
        <Typography.Title level={5}>Текст несохранённой попытки</Typography.Title>
        <Typography.Paragraph className="catalog-requests__text" copyable={{text:draft}}>{draft}</Typography.Paragraph>
    </div>;
}
