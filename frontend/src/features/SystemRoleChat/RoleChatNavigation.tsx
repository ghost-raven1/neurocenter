import {Select} from 'antd';
import {roleName, type SystemRoleId} from '../SystemRoles/types';

export const serviceRoleIds: readonly SystemRoleId[] = ['agent-coordinator', 'agent-ai-admin', 'agent-autoconfigurator', 'agent-indexer', 'agent-packager'];

/** Role threads remain navigable when new execution is disabled, so history stays reachable. */
export function RoleChatNavigation({selected, onSelect}: {selected?: SystemRoleId; onSelect: (role: SystemRoleId) => void}): JSX.Element {
    return <label>Чат роли<Select aria-label="Чат сервисной роли" placeholder="Выберите роль" value={selected}
        options={serviceRoleIds.map(value => ({value, label: roleName(value)}))} onChange={onSelect}/></label>;
}
