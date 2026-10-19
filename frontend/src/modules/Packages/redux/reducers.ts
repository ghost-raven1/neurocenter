import { createSlice } from '@reduxjs/toolkit';

import { fetchPackageCollections, fetchPackages } from './actions';
import type { IPackage } from '../../../core/api/interfaces';

interface IPackageCollection {
    id: string;
    title: string;
}

export interface IPackagesState {
    collections: IPackageCollection[];
    collectionId: string | null;
    packages: IPackage[];
    loading: boolean;
}

const initialState: IPackagesState = {
    collections: [],
    collectionId: null,
    packages: [],
    loading: false,
};

const packagesSlice = createSlice({
    name: 'packages',
    initialState,
    reducers: {
        setCollectionId: (state, action: { payload: string }) => {
            state.collectionId = action.payload;
        },
    },
    extraReducers: builder => {
        builder
            .addCase(fetchPackageCollections.fulfilled, (state, action) => {
                state.collections = action.payload;
            })
            .addCase(fetchPackages.pending, state => {
                state.loading = true;
            })
            .addCase(fetchPackages.fulfilled, (state, action) => {
                state.loading = false;
                state.packages = action.payload;
            })
            .addCase(fetchPackages.rejected, state => {
                state.loading = false;
            });
    },
});

export const { setCollectionId } = packagesSlice.actions;

export default packagesSlice.reducer;
