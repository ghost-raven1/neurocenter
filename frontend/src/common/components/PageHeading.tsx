import { Space, Typography } from 'antd';
import { FC, ReactNode } from 'react';

interface IPageHeadingProps { title: string; description: string; actions?: ReactNode; }

/** Единая иерархия заголовка, объяснения и основных действий страницы. */
export const PageHeading: FC<IPageHeadingProps> = ({ title, description, actions }) => (
    <div className="page-heading">
        <div><Typography.Title level={1}>{title}</Typography.Title><Typography.Paragraph type="secondary">{description}</Typography.Paragraph></div>
        {actions && <Space wrap>{actions}</Space>}
    </div>
);
