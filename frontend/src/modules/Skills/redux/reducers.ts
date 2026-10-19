import { createSlice } from '@reduxjs/toolkit';

import type { ISkillFile, ISkillListSummary, ISkillTreeNode } from '../../../core/api/interfaces';

import {
    createSkill,
    createSkillDirectory,
    deleteSkill,
    fetchSkill,
    fetchSkillList,
    fetchSkillTree,
    updateSkill,
} from './actions';

export interface ISkillsState {
    tree: ISkillTreeNode[];
    selectedPath: string | null;
    skills: ISkillListSummary[];
    query: string;
    treeLoading: boolean;
    listLoading: boolean;
    editorOpen: boolean;
    editorMode: 'create' | 'edit';
    editorPath: string | null;
    editorSkill: ISkillFile | null;
    editorSaving: boolean;
}

const initialState: ISkillsState = {
    tree: [],
    selectedPath: null,
    skills: [],
    query: '',
    treeLoading: false,
    listLoading: false,
    editorOpen: false,
    editorMode: 'create',
    editorPath: null,
    editorSkill: null,
    editorSaving: false,
};

const skillsSlice = createSlice({
    name: 'skills',
    initialState,
    reducers: {
        setSelectedPath: (state, action: { payload: string }) => {
            state.selectedPath = action.payload;
            state.skills = [];
            state.query = '';
        },
        setQuery: (state, action: { payload: string }) => {
            state.query = action.payload;
        },
        openEditor: (state, action: { payload: { mode: 'create' | 'edit'; path: string } }) => {
            state.editorOpen = true;
            state.editorMode = action.payload.mode;
            state.editorPath = action.payload.path;
            state.editorSkill = null;
            state.editorSaving = false;
        },
        closeEditor: state => {
            state.editorOpen = false;
            state.editorMode = 'create';
            state.editorPath = null;
            state.editorSkill = null;
            state.editorSaving = false;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(fetchSkillTree.pending, state => {
                state.treeLoading = true;
            })
            .addCase(fetchSkillTree.fulfilled, (state, action) => {
                state.treeLoading = false;
                state.tree = action.payload;
            })
            .addCase(fetchSkillTree.rejected, state => {
                state.treeLoading = false;
            })
            .addCase(fetchSkillList.pending, state => {
                state.listLoading = true;
            })
            .addCase(fetchSkillList.fulfilled, (state, action) => {
                state.listLoading = false;
                state.skills = action.payload;
            })
            .addCase(fetchSkillList.rejected, state => {
                state.listLoading = false;
            })
            .addCase(fetchSkill.fulfilled, (state, action) => {
                state.editorSkill = action.payload;
            })
            .addCase(createSkill.pending, state => {
                state.editorSaving = true;
            })
            .addCase(updateSkill.pending, state => {
                state.editorSaving = true;
            })
            .addCase(createSkill.fulfilled, state => {
                state.editorSaving = false;
            })
            .addCase(updateSkill.fulfilled, state => {
                state.editorSaving = false;
            })
            .addCase(createSkill.rejected, state => {
                state.editorSaving = false;
            })
            .addCase(updateSkill.rejected, state => {
                state.editorSaving = false;
            })
            .addCase(createSkillDirectory.fulfilled, () => undefined)
            .addCase(deleteSkill.fulfilled, () => undefined);
    },
});

export const { setSelectedPath, setQuery, openEditor, closeEditor } = skillsSlice.actions;

export default skillsSlice.reducer;
