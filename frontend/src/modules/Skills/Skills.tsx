import { Button, Card, Col, Input, message, Modal, Row, Select, Space, Typography } from 'antd';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import Permission from '../../common/components/Permission';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { useAppDispatch } from '../../core/hooks';
import socketClient from '../../core/socket/socketClient';
import { skillCollectionManageKey, skillsPolitics } from '../../features/UserBlock/permissions';
import { RootState } from '../../store';

import SkillCatalogTree from './components/SkillCatalogTree';
import SkillEditorModal from './components/SkillEditorModal';
import SkillListTable from './components/SkillListTable';
import { createSkillDirectory, fetchSkillList, fetchSkillTree } from './redux/actions';
import { openEditor, setSelectedPath, setQuery } from './redux/reducers';
import { notifySkillMutation } from '../../features/Catalog/skillMutationFeedback';

const { Title } = Typography;

/**
 * Экран «Скиллы»: слева — дерево каталога (CephFS), справа — список `.md` + редактор
 * (Markdown + метаданные + связи с MCP/плагинами). CRUD + real-time.
 *
 * @component
 */
const Skills: FC = () => {
    const dispatch = useAppDispatch();
    const { tree, selectedPath, query } = useSelector((state: RootState) => state.skills);
    const [ dirModalOpen, setDirModalOpen ] = useState(false);
    const [ dirName, setDirName ] = useState('');
    const [ directorySaving, setDirectorySaving ] = useState(false);
    const directoryLock = useRef(false);
    const { scope, captureOwner } = useAuthRequestOwner();

    useEffect(() => {
        directoryLock.current = false;
        setDirectorySaving(false);
        setDirModalOpen(false);
        setDirName('');
    }, [scope]);

    useEffect(() => {
        dispatch(fetchSkillTree());
        socketClient.connect();
    }, [dispatch]);

    /* По умолчанию показываем все скиллы (пустой путь = весь каталог). */
    useEffect(() => {
        if (selectedPath === null) {
            dispatch(setSelectedPath(''));
        }
    }, [dispatch, selectedPath]);

    /* При смене каталога/поиска — перезагрузить список. */
    useEffect(() => {
        if (selectedPath !== null) {
            dispatch(fetchSkillList({ path: selectedPath, query }));
        }
    }, [dispatch, selectedPath, query]);

    /* Real-time: скилл изменился → перезагрузить дерево и текущий список. */
    useEffect(() => {
        const handleSkillChanged = (): void => {
            dispatch(fetchSkillTree());

            if (selectedPath !== null) {
                dispatch(fetchSkillList({ path: selectedPath, query }));
            }
        };

        socketClient.on('skill:changed', handleSkillChanged);

        return () => {
            socketClient.off('skill:changed', handleSkillChanged);
        };
    }, [dispatch, selectedPath, query]);

    const handleQuery = useCallback(
        (value: string): void => {
            dispatch(setQuery(value));
        },
        [dispatch],
    );

    const handleNewSkill = useCallback(
        (): void => {
            dispatch(openEditor({ mode: 'create', path: selectedPath ?? '' }));
        },
        [dispatch, selectedPath],
    );

    const handleNewDirectory = useCallback((): void => {
        setDirName('');
        setDirModalOpen(true);
    }, []);

    const [ projectFilter, setProjectFilter ] = useState<string>('');

    /* Каталоги проектов из дерева (project-*): быстрый переход к скиллам проекта. */
    const projectFolders = tree.filter(node => node.type === 'dir' && node.name.startsWith('project-'));

    const handleProjectFilter = useCallback(
        (value?: string): void => {
            setProjectFilter(value ?? '');
            dispatch(setSelectedPath(value ?? ''));
        },
        [ dispatch ],
    );

    const handleCreateDirectory = useCallback((): void => {
        const isCurrent = captureOwner();
        if (directoryLock.current || !isCurrent()) { return; }
        const name = dirName.trim();

        if (name.length === 0) {
            message.warning('Укажите имя папки');

            return;
        }

        const base = (selectedPath ?? '').replace(/\/+$/, '');
        const fullPath = base.length > 0 ? `${base}/${name}` : name;

        directoryLock.current = true;
        setDirectorySaving(true);
        dispatch(createSkillDirectory(fullPath)).unwrap()
            .then(result => {
                if (!isCurrent()) { return; }
                notifySkillMutation(result, 'Папка создана', 'directory');
                setDirModalOpen(false);
                dispatch(fetchSkillTree());
            })
            .catch(error => { if (isCurrent()) { message.error(errorMessage(error, 'Не удалось создать папку')); } })
            .finally(() => { if (isCurrent()) { directoryLock.current = false; setDirectorySaving(false); } });
    }, [dispatch, dirName, selectedPath, captureOwner]);

    return (
        <Card title={<Title level={4} style={{ margin: 0 }}>Скиллы</Title>}>
            <Row gutter={16}>
                <Col span={6}>
                    <Card size="small" title="Каталог">
                        <SkillCatalogTree />
                    </Card>
                </Col>
                <Col span={18}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <Space>
                            <Select
                                allowClear
                                placeholder="По проекту"
                                style={{ width: 200 }}
                                value={projectFilter || undefined}
                                onChange={handleProjectFilter}
                                options={[
                                    { value: 'common', label: 'Общие (common)' },
                                    ...projectFolders.map(folder => ({ value: folder.path, label: folder.name.replace(/^project-/, '') })),
                                ]}
                            />
                            <Input.Search
                                allowClear
                                placeholder="Поиск по каталогу"
                                style={{ width: 240 }}
                                value={query}
                                onChange={event => handleQuery(event.target.value)}
                            />
                        </Space>
                        <Permission permissionKey={skillCollectionManageKey} politic={skillsPolitics}>
                            <Space>
                                <Button onClick={handleNewSkill}>Новый скилл</Button>
                                <Button onClick={handleNewDirectory}>Новая папка</Button>
                            </Space>
                        </Permission>
                    </div>
                    <SkillListTable dirPath={selectedPath ?? ''} />
                </Col>
            </Row>

            <SkillEditorModal dirPath={selectedPath ?? ''} />

            <Modal
                title="Новая папка"
                open={dirModalOpen}
                onOk={handleCreateDirectory}
                onCancel={() => { if (!directoryLock.current) { setDirModalOpen(false); } }}
                confirmLoading={directorySaving}
                cancelButtonProps={{ disabled: directorySaving }}
                closable={!directorySaving}
                keyboard={!directorySaving}
                maskClosable={!directorySaving}
            >
                <Input
                    value={dirName}
                    disabled={directorySaving}
                    onChange={event => setDirName(event.target.value)}
                    onPressEnter={handleCreateDirectory}
                    placeholder="имя папки"
                    autoFocus
                />
            </Modal>
        </Card>
    );
};

export default Skills;
