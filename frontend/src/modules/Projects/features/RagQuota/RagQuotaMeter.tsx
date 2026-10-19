import {Alert,Card,Progress,Space,Typography} from 'antd';
import {Link} from 'react-router-dom';
import type {IRagQuota} from '../../../../core/api/interfaces';
import {formatRagBytes,ragQuotaPercent,requireRagQuota} from './model';
import './RagQuota.less';

/** Участник видит расход; изменение лимита доступно только администратору проекта. */
export function RagQuotaMeter({value,projectKey,canEdit}:{value:IRagQuota;projectKey:string;canEdit:boolean}):JSX.Element{
    let quota;try{quota=requireRagQuota(value);}catch{return <Alert type="warning" showIcon message="Не удалось подтвердить расход базы знаний. Обновите сведения." />;}
    return <Card className="rag-quota-card" size="small" title="Лимит базы знаний" extra={canEdit?<Link to={`/projects/${encodeURIComponent(projectKey)}?tab=quotas`}>Изменить лимит</Link>:undefined}>
        <Space direction="vertical" size={4} style={{width:'100%'}}>
            <Typography.Text>{formatRagBytes(quota.usedBytes)} из {formatRagBytes(quota.limitBytes)} · доступно {formatRagBytes(quota.availableBytes)}</Typography.Text>
            <Progress percent={ragQuotaPercent(quota)} status={quota.availableBytes===0?'exception':'normal'} />
            {quota.availableBytes===0&&<Typography.Text type="warning">Лимит достигнут. Просмотр и скачивание доступны; для отправки новых знаний уменьшите объём или увеличьте лимит.</Typography.Text>}
        </Space>
    </Card>;
}
