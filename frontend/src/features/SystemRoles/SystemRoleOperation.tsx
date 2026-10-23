import { Alert, Button, Modal, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { systemRolesApi } from './api';
import { RoleRunContent } from './RoleRunContent';
import { roleFlag, roleName, type RoleRun, type SystemRoleId } from './types';
import './SystemRoles.less';

/** Feed metadata is public to project readers; this endpoint separately authorizes private proposal access. */
export function SystemRoleOperation({ agentId, runId }: { agentId: SystemRoleId; runId: string }): JSX.Element {
    const [open, setOpen] = useState(false), [run, setRun] = useState<RoleRun>(), [loadedIdentity, setLoadedIdentity] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const { scope, captureOwner } = useAuthRequestOwner(), availability = useFeatureAvailability(roleFlag(agentId)), enabled = useRef(availability.enabled); enabled.current = availability.enabled;
    const current = useRef({ agentId, runId, open, scope }); current.current = { agentId, runId, open, scope };
    const identity = JSON.stringify([scope, agentId, runId]), visibleRun = loadedIdentity === identity ? run : undefined;
    const load = async (): Promise<void> => {
        const owns = captureOwner(); if (!owns()) return; setBusy(true);
        try { const value = await systemRolesApi.get(agentId, runId); if (owns() && current.current.agentId === agentId && current.current.runId === runId && current.current.open) { setRun(value); setLoadedIdentity(identity); setError(''); } }
        catch { if (owns() && current.current.runId === runId && current.current.open) setError('Подробности доступны инициатору и администратору с текущим доступом. Не удалось подтвердить доступ или связь.'); }
        finally { if (owns() && current.current.runId === runId && current.current.open) setBusy(false); }
    };
    useEffect(() => { setRun(undefined); setError(''); if (open) void load(); }, [open, agentId, runId, captureOwner]);
    const action = async (kind: 'apply' | 'rollback'): Promise<void> => {
        if (!visibleRun || busy || kind === 'apply' && !enabled.current || current.current.runId !== runId || current.current.agentId !== agentId) return;
        const owns = captureOwner(); if (!owns()) return; setBusy(true);
        try { const value = await systemRolesApi.action(visibleRun, kind, crypto.randomUUID()); if (owns() && current.current.runId === runId && current.current.open) { setRun(value); setLoadedIdentity(identity); setError(''); } }
        catch { if (owns() && current.current.runId === runId && current.current.open) setError('Исход действия не подтверждён. Перечитайте версию у владельца перед следующим действием.'); }
        finally { if (owns() && current.current.runId === runId && current.current.open) setBusy(false); }
    };
    return <><Button size="small" onClick={() => setOpen(true)}>Результат {roleName(agentId)}</Button><Modal title={roleName(agentId)} open={open} width={1000} onCancel={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Закрыть</Button>} destroyOnClose>
        <div className="system-role"><Space><Button loading={busy} onClick={() => { void load(); }}>Перечитать результат</Button></Space>{error && <Alert type="warning" showIcon message={error} />}
            {visibleRun && <><RoleRunContent run={visibleRun} /><Space wrap>{visibleRun.canApply && <Button disabled={!availability.enabled || busy} onClick={() => { void action('apply'); }}>Применить показанное предложение</Button>}
                {visibleRun.canRollback && <Button disabled={busy} onClick={() => { void action('rollback'); }}>Откатить подтверждённые изменения</Button>}</Space></>}
        </div></Modal></>;
}
