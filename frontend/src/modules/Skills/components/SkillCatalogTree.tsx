import { Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import type { Key } from 'react';
import { FC, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';

import { useAppDispatch } from '../../../core/hooks';
import type { ISkillTreeNode } from '../../../core/api/interfaces';
import { RootState } from '../../../store';

import { fetchSkill } from '../redux/actions';
import { openEditor, setSelectedPath } from '../redux/reducers';

const FILE_KEY_PREFIX = 'file:';

/**
 * Лёвое дерево каталога скиллов: папки (выбор каталога) и `.md`-файлы (открытие в редакторе).
 *
 * @component
 */
const SkillCatalogTree: FC = () => {
    const dispatch = useAppDispatch();
    const { tree, selectedPath } = useSelector((state: RootState) => state.skills);

    const toData = useCallback(
        (nodes: ISkillTreeNode[]): DataNode[] =>
            nodes.map(node => ({
                key: node.type === 'dir' ? (node.path || 'root') : `${FILE_KEY_PREFIX}${node.path}`,
                title: node.type === 'dir' ? node.name : `${node.name}.md`,
                isLeaf: node.type === 'file',
                children: node.children !== undefined ? toData(node.children) : undefined,
            })),
        [],
    );

    const data = useMemo(
        () => [
            { key: 'root', title: 'Все скиллы', isLeaf: true },
            ...toData(tree),
        ],
        [tree, toData],
    );

    const handleSelect = useCallback(
        (keys: Key[]): void => {
            const key = keys.length > 0 ? `${keys[0]}` : '';

            if (key.startsWith(FILE_KEY_PREFIX)) {
                const path = key.slice(FILE_KEY_PREFIX.length);

                dispatch(openEditor({ mode: 'edit', path }));
                dispatch(fetchSkill(path));

                return;
            }

            if (key === 'root') {
                dispatch(setSelectedPath(''));

                return;
            }

            if (key.length > 0) {
                dispatch(setSelectedPath(key));
            }
        },
        [dispatch],
    );

    const selectedKeys: Key[] = selectedPath === null ? [] : [ selectedPath === '' ? 'root' : selectedPath ];

    return <Tree blockNode treeData={data} selectedKeys={selectedKeys} onSelect={handleSelect} />;
};

export default SkillCatalogTree;
