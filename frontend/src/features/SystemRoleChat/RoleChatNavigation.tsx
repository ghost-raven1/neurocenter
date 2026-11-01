import { Select } from 'antd';
import { roleName } from '../SystemRoles/utils';
import { type TSystemRoleId } from '../SystemRoles/interfaces';

export const serviceRoleIds: readonly TSystemRoleId[] = [
    'agent-coordinator',
    'agent-ai-admin',
    'agent-autoconfigurator',
    'agent-indexer',
    'agent-packager',
];

/** Role threads remain navigable when new execution is disabled, so history stays reachable. */
export function RoleChatNavigation({
    selected,
    onSelect,
}: {
    selected?: TSystemRoleId;
    onSelect: (role: TSystemRoleId) => void;
}): JSX.Element {
    return (
        <label>
            Чат роли
            <Select
                aria-label="Чат сервисной роли"
                placeholder="Выберите роль"
                value={selected}
                options={serviceRoleIds.map((value) => ({ value, label: roleName(value) }))}
                onChange={onSelect}
            />
        </label>
    );
}
