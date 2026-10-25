import {AppstoreOutlined, FolderOutlined, QuestionCircleOutlined, RocketOutlined, SettingOutlined} from '@ant-design/icons';
import {Menu} from 'antd';
import type {MenuProps} from 'antd';
import {useEffect, useState, type ReactNode} from 'react';
import {navigationGroups, selectedNavigationEntry, type NavigationEntry} from './model';
import './AppNavigation.less';

interface Props {entries: NavigationEntry[]; pathname: string; active: boolean; onNavigate: (route: string) => void; onClose: () => void;}
const icons: Record<string, ReactNode> = {
    start: <RocketOutlined aria-hidden="true"/>, work: <FolderOutlined aria-hidden="true"/>, resources: <AppstoreOutlined aria-hidden="true"/>, management: <SettingOutlined aria-hidden="true"/>, help: <QuestionCircleOutlined aria-hidden="true"/>,
};

/** One expanded section keeps navigation short; current routes reopen on navigation or opening the mobile drawer. */
export function AppNavigation({entries, pathname, active, onNavigate, onClose}: Props): JSX.Element {
    const selected = selectedNavigationEntry(entries, pathname), selectedGroup = selected?.group ?? null;
    const [openKeys, setOpenKeys] = useState<string[]>(selectedGroup ? [selectedGroup] : []);
    useEffect(() => {if (active) setOpenKeys(selectedGroup ? [selectedGroup] : []);}, [active, pathname, selectedGroup]);
    const leaf = (entry: NavigationEntry) => ({key: entry.route, icon: entry.group ? undefined : icons[entry.name], label: entry.external
        ? <a className="app-navigation__external-link" href={entry.route} target="_blank" rel="noopener noreferrer">{entry.title}</a> : entry.title,
        className: entry.external ? 'app-navigation__external-item' : undefined});
    const groups = navigationGroups.flatMap(group => {
        const children = entries.filter(entry => entry.group === group.key);
        return children.length ? [{key: group.key, label: group.title, icon: icons[group.key], children: children.map(leaf)}] : [];
    });
    const items: MenuProps['items'] = [...entries.filter(entry => !entry.group).map(leaf), ...groups];
    return <nav aria-label="Основная навигация" className="app-navigation"><Menu theme="dark" mode="inline" items={items}
        selectedKeys={selected ? [selected.route] : []} openKeys={openKeys.filter(key => groups.some(group => group.key === key))}
        onOpenChange={keys => setOpenKeys(keys.filter(key => !openKeys.includes(key)).slice(-1))}
        onClick={({key}) => {const entry = entries.find(item => item.route === key); if (!entry) return;
            if (!entry.external) onNavigate(entry.route); onClose();}}/></nav>;
}
