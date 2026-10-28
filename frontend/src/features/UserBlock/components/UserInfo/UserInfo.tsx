import { BellOutlined, DownOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Button, Dropdown, Modal, message } from 'antd';
import block from 'bem-cn';
import { FC, useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { useSelector } from 'react-redux';
import { useHistory } from 'react-router-dom';

import { useAppDispatch } from '../../../../core/hooks';
import { RootState } from '../../../../store';
import {authLogout} from '../../redux/actions';
import { RoleSwitcher } from '../RoleSwitcher';
import {NotificationSoundSettings} from '../../../NotificationSounds/NotificationSoundSettings';
import './UserInfo.less';

const b = block('user-info');

/**
 * Информация о текущем пользователе + выход в хеддере.
 *
 * @component
 * @returns JSX-элемент блока пользователя
 */
const UserInfo: FC = () => {
    const dispatch = useAppDispatch();
    const { user } = useSelector((state: RootState) => state.userBlock);
    const history = useHistory();
    const menuButton = useRef<HTMLElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [notificationsOpen, setNotificationsOpen] = useState(false);

    /** Close before AntD's menu queues another focus move into the hidden popup. */
    const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !(event.target instanceof Element) || !event.target.closest('[role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        menuButton.current?.focus();
    };

    /**
     * Выход: сначала отзыв серверной сессии, затем экран входа и завершение SSO.
     *
     * @returns void
     */
    const handleLogout = useCallback(async () => {
        try{
            const result=await dispatch(authLogout()).unwrap();
            if(result.redirectUrl){window.location.assign(result.redirectUrl);}else{history.push('/');}
        }catch{message.error('Не удалось завершить сессию. Повторите выход.');}
    }, [ dispatch, history ]);

    if (!user) {
        return null;
    }

    return (
        <><Dropdown
            open={menuOpen}
            onOpenChange={setMenuOpen}
            dropdownRender={menu => <div className="user-info__dropdown" onKeyDownCapture={handleMenuKeyDown}>
                <div className="user-info__account" onClick={event => event.stopPropagation()}>
                    <strong>{user.displayName}</strong>
                    <span className="user-info__email">{user.email}</span>
                    <span className="user-info__role-label">Активная роль</span>
                    <RoleSwitcher />
                </div>
                {menu}
            </div>}
            menu={{
                onClick: () => setMenuOpen(false),
                items: [
                    {key: 'notifications', icon: <BellOutlined/>, label: 'Настройки уведомлений', onClick: () => setNotificationsOpen(true)},
                    {
                        key: 'logout',
                        icon: <LogoutOutlined />,
                        label: 'Выйти',
                        onClick: () => {
                            void handleLogout();
                        },
                    },
                ],
            }}
            trigger={['click']}
        >
            <Button ref={menuButton} type="text" className={b().toString()} aria-label="Меню пользователя"
                aria-haspopup="menu" aria-expanded={menuOpen} icon={<UserOutlined />}>
                <span className="user-info__name">{user.displayName}</span>
                <DownOutlined />
            </Button>
        </Dropdown><Modal title="Настройки уведомлений" open={notificationsOpen} onCancel={() => setNotificationsOpen(false)} footer={null} destroyOnClose>
            {notificationsOpen && <NotificationSoundSettings embedded/>}
        </Modal></>
    );
};

export default UserInfo;
