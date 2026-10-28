import { Alert, Button, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoleMcpReceipt } from '../../../../services/shared/system-role-mcp.cjs';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { systemRolesApi } from './api';
import type { RoleRun } from './types';
import './RoleMcpResults.less';

interface ReceiptState { owner: object; status: 'idle' | 'loading' | 'ready' | 'error'; receipts?: RoleMcpReceipt[]; error?: string; }
const states = { succeeded: 'Ответ получен', failed: 'Вызов не завершён', unknown: 'Исход не подтверждён', cancelled: 'Вызов отменён' };

/** History reads saved receipts explicitly; opening or refreshing it never dispatches tools. */
export function RoleMcpResults({ run }: { run: Pick<RoleRun, 'id' | 'projectId' | 'agentId'> }): JSX.Element {
    const { scope, captureOwner } = useAuthRequestOwner();
    const owner = useMemo(() => ({ active: false, generation: 0, busy: false }), [scope, run.id, run.projectId, run.agentId]);
    const current = useRef(owner); current.current = owner;
    const [state, setState] = useState<ReceiptState>({ owner, status: 'idle' });
    useEffect(() => {
        owner.active = true; owner.generation++; owner.busy = false;
        return () => { owner.active = false; owner.generation++; owner.busy = false; };
    }, [owner]);
    const read = async (): Promise<void> => {
        const auth = captureOwner(), generation = owner.generation;
        const owns = (): boolean => auth() && owner.active && current.current === owner && owner.generation === generation;
        if (!owns() || owner.busy) return;
        owner.busy = true; setState({ owner, status: 'loading' });
        try {
            const receipts = await systemRolesApi.mcpCalls(run.id);
            if (owns()) setState({ owner, status: 'ready', receipts });
        } catch (cause) {
            if (owns()) setState({ owner, status: 'error', error: errorMessage(cause, 'Квитанции MCP не загрузились. Перечитайте сохранённый журнал.') });
        } finally { if (owns()) owner.busy = false; }
    };
    const visible: Omit<ReceiptState, 'owner'> = state.owner === owner ? state : { status: 'idle' };
    return <details className="role-mcp-results">
        <summary>Результаты MCP</summary>
        <Button size="small" disabled={visible.status === 'loading'} onClick={() => void read()}>{visible.status === 'idle' ? 'Прочитать квитанции' : 'Перечитать квитанции'}</Button>
        {visible.status === 'loading' && <Typography.Paragraph role="status">Читаем квитанции MCP…</Typography.Paragraph>}
        {visible.error && <Alert showIcon type="warning" message={visible.error} />}
        {visible.receipts?.length === 0 && <Typography.Paragraph>Вызовов MCP в этом запуске нет.</Typography.Paragraph>}
        {visible.receipts?.map(receipt => <section key={receipt.id}>
            <Space wrap><Typography.Text strong>{receipt.name}</Typography.Text><Tag color={receipt.state === 'succeeded' && !receipt.output?.isError ? 'success' : 'warning'}>{states[receipt.state]}</Tag></Space>
            <Typography.Paragraph>{receipt.message}</Typography.Paragraph>
            <Typography.Paragraph>Квитанция: <Typography.Text copyable>{receipt.id}</Typography.Text> · {new Date(receipt.at).toLocaleString('ru-RU')}</Typography.Paragraph>
            {receipt.output ? <>
                {receipt.output.isError && <Alert showIcon type="warning" message="Инструмент сообщил об ошибке." />}
                {receipt.output.truncated && <Alert showIcon type="info" message="Ответ сокращён при сохранении." />}
                <Typography.Text strong>Сохранённый ответ инструмента</Typography.Text><pre>{receipt.output.text}</pre>
                {receipt.output.structuredContent !== undefined && <details><summary>Структурированный ответ</summary><pre>{JSON.stringify(receipt.output.structuredContent, null, 2)}</pre></details>}
            </> : <Typography.Paragraph type="secondary">Сохранённого ответа инструмента нет.</Typography.Paragraph>}
        </section>)}
    </details>;
}
