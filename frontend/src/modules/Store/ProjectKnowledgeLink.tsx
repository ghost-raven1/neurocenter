import { Typography } from 'antd';
import { Link } from 'react-router-dom';
import { baseRoutes } from '../../core/baseRoutes';

/** Единственный переход из каталога к операциям со знаниями выбранного проекта. */
export function ProjectKnowledgeLink({projectId}: {projectId: string}) {
    const path = baseRoutes.projectDetail.replace(':projectId', encodeURIComponent(projectId));
    return <Typography.Paragraph type="secondary">
        Загрузка и синхронизация доступны в <Link to={`${path}?tab=rag`}>базе знаний проекта</Link>.
    </Typography.Paragraph>;
}
