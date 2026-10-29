import {lazy, Suspense, useState} from 'react';
import {Spin} from 'antd';
import {LazySectionBoundary} from '../../../common/components/LazySection/LazySection';
import {useAuthRequestOwner} from '../../../features/UserBlock/useAuthRequestOwner';
import {ProjectTextKnowledge} from '../../../features/ProjectTextKnowledge/ProjectTextKnowledge';
import './RagTab.less';

const SemanticRag = lazy(() => import('./SemanticRag'));

/** Text knowledge opens immediately; semantic tools mount only after an explicit choice. */
export default function RagTab({projectKey}:{projectKey:string}):JSX.Element {
    const {scope} = useAuthRequestOwner();
    const owner = JSON.stringify([scope, projectKey]);
    const [expanded, setExpanded] = useState('');
    return <div className="project-rag">
        <ProjectTextKnowledge key={owner} projectId={projectKey} />
        <details className="project-rag__advanced" open={expanded === owner} onToggle={event => {
            setExpanded(event.currentTarget.open ? owner : '');
        }}>
            <summary>Семантический поиск и локальный индекс</summary>
            {expanded === owner && <LazySectionBoundary key={owner} reload={() => window.location.reload()}>
                <Suspense fallback={<Spin tip="Загружаем настройки индекса…" />}><SemanticRag projectKey={projectKey} /></Suspense>
            </LazySectionBoundary>}
        </details>
    </div>;
}
