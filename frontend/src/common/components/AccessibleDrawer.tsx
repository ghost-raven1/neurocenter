import { Drawer } from 'antd';
import type { DrawerProps } from 'antd';
import { useCallback, useId } from 'react';
import type { FC, ReactNode } from 'react';

type AccessibleDrawerProps = Omit<DrawerProps, 'title'> & { title: ReactNode };

/** Ant Design 4 не передаёт aria-labelledby внутреннему dialog; связываем его с видимым заголовком. */
const AccessibleDrawer: FC<AccessibleDrawerProps> = ({ title, ...props }) => {
    const titleId = useId();
    const labelDialog = useCallback((element: HTMLDivElement | null) => {
        element?.closest('[role="dialog"]')?.setAttribute('aria-labelledby', titleId);
    }, [titleId]);

    return <Drawer {...props} title={<div id={titleId} ref={labelDialog}>{title}</div>} />;
};

export default AccessibleDrawer;
