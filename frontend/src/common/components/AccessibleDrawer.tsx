import { Drawer, DrawerProps } from 'antd';
import { FC, ReactNode, useCallback, useId } from 'react';

type TAccessibleDrawerProps = Omit<DrawerProps, 'title'> & { title: ReactNode };

const AccessibleDrawer: FC<TAccessibleDrawerProps> = ({ title, ...props }) => {
    const titleId = useId();

    const labelDialog = useCallback(
        (element: HTMLDivElement | null) => {
            element?.closest('[role="dialog"]')?.setAttribute('aria-labelledby', titleId);
        },
        [titleId],
    );

    return (
        <Drawer
            {...props}
            title={
                <div id={titleId} ref={labelDialog}>
                    {title}
                </div>
            }
        />
    );
};

export default AccessibleDrawer;
