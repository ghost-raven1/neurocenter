import { Button, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { RoleRunContent, rolePhaseLabel } from '../SystemRoles/RoleRunContent';
import {RoleAnswer} from '../SystemRoles/RoleGuidance';
import { roleFlag, roleName } from '../SystemRoles/types';
import type { ServiceTurn } from './types';
import {AuditOutlined} from '@ant-design/icons';
import {ChatActivityGroup} from '../ChatCommon/ChatActivityGroup';

/** Summary stays readable in the conversation; exact measurements and owner diffs expand on demand. */
export function ServiceTurnContent({ turn, busy, onAction }: { turn: ServiceTurn; busy: boolean; onAction: (turn: ServiceTurn, action: 'cancel' | 'apply' | 'rollback') => Promise<void> }): JSX.Element {
    const run = turn.run, availability = useFeatureAvailability('system_role_chat', roleFlag(turn.agentId)), enabled = useRef(availability.enabled); enabled.current = availability.enabled;
    const { captureOwner } = useAuthRequestOwner(), confirmation = useRef<ReturnType<typeof Modal.confirm>>();
    useEffect(() => () => { confirmation.current?.destroy(); }, []);
    const confirm = (action: 'apply' | 'rollback'): void => {
        if (busy || action === 'apply' && !enabled.current) return; const owns = captureOwner();
        confirmation.current = Modal.confirm({ title: action === 'apply' ? 'Применить проверенное предложение?' : 'Откатить подтверждённые изменения?',
            content: 'Владельцы проверят актуальные версии. Результат сохранится в истории задачи.', okText: action === 'apply' ? 'Применить' : 'Откатить', cancelText: 'Вернуться',
            onOk: () => { if (owns() && (action === 'rollback' || enabled.current)) return onAction(turn, action); } });
    };
    return <article className="service-chat__turn">
        <div className="service-chat__request"><Typography.Text strong>Вы</Typography.Text><Typography.Paragraph>{turn.instruction}</Typography.Paragraph></div>
        <div className="service-chat__answer"><Space wrap><Typography.Text strong>{roleName(turn.agentId)}</Typography.Text><Tag>{run ? rolePhaseLabel(run.phase) : 'Проверяем состояние'}</Tag></Space>
            {run?.result ? <RoleAnswer result={run.result} /> : <div role="status"><Typography.Paragraph>{run?.message || 'Перечитайте состояние задачи.'}</Typography.Paragraph></div>}
            {!!run?.result?.delegations?.length && <div className="service-chat__delegations">{run.result.delegations.map(item => <Tag key={item.roleId} color={item.state === 'succeeded' ? 'success' : 'warning'}>{roleName(item.roleId)} · {item.state === 'succeeded' ? 'Ответ получен' : 'Не завершено'}</Tag>)}</div>}
            {run && <ChatActivityGroup icon={<AuditOutlined/>} label="Измерения, предложения и этапы"><RoleRunContent run={run} showAnswer={false} /></ChatActivityGroup>}
            <Space wrap>
                {run?.canCancel && <Button size="small" disabled={busy || turn.cancelRequested} onClick={() => { if (captureOwner()()) void onAction(turn, 'cancel'); }}>{turn.cancelRequested ? 'Отмена запрошена' : 'Отменить задачу'}</Button>}
                {run?.canApply && <Button size="small" type="primary" disabled={busy || !availability.enabled} onClick={() => confirm('apply')}>Применить предложение</Button>}
                {run?.canRollback && <Button size="small" disabled={busy} onClick={() => confirm('rollback')}>Откатить изменения</Button>}
            </Space>
            {run?.canApply && !availability.enabled && <Typography.Paragraph type="secondary">{availability.reason}</Typography.Paragraph>}
        </div>
    </article>;
}
