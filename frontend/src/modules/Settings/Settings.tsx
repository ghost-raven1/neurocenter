import {Alert, Card, Typography} from 'antd';
import {useSelector} from 'react-redux';
import {Link} from 'react-router-dom';
import {PageHeading} from '../../common/components/PageHeading';
import {baseRoutes} from '../../core/baseRoutes';
import {isMainAdminRole} from '../../features/UserBlock/roles';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import type {RootState} from '../../store';
import {BridgeSourceSettings} from './BridgeSourceSettings';
import {AssetSourceSettings} from './AssetSourceSettings';
import {NotificationSoundSettings} from '../../features/NotificationSounds/NotificationSoundSettings';
import {RuntimeLimitsSettings} from '../../features/RuntimeLimits/RuntimeLimitsSettings';
import './Settings.less';

/** Global sources belong to the active main administrator; each account gets its own form lifecycle. */
export default function Settings(): JSX.Element {
    const {scope} = useAuthRequestOwner();
    const user = useSelector((state: RootState) => state.userBlock.user);
    const canManage = !!user && user.userRoles.includes(user.activeRole) && isMainAdminRole(user.activeRole);
    return <section className="settings-page"><PageHeading title="Настройки" description="Общие источники и параметры Нейроцентра."/>
        {user?.id && user.principalName && <NotificationSoundSettings/>}
        {canManage ? <div key={scope} className="settings-page__sections"><BridgeSourceSettings/><AssetSourceSettings/><RuntimeLimitsSettings/>
            <div className="settings-page__shortcuts">
                <Card size="small" title="Функции и обслуживание"><Typography.Paragraph type="secondary">Фичафлаги, хранилище, резервные копии и восстановление.</Typography.Paragraph><Link to={baseRoutes.maintenance}>Открыть управление платформой</Link></Card>
                <Card size="small" title="Доступ"><Typography.Paragraph type="secondary">Участники, роли и доступ к проектам.</Typography.Paragraph><Link to={baseRoutes.access}>Управлять доступом</Link></Card>
            </div>
        </div> : <Alert type="info" showIcon message="Общие настройки доступны главному администратору"/>}
    </section>;
}
