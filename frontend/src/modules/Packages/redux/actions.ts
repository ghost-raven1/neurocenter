import { createAsyncThunk } from '@reduxjs/toolkit';

import bffApi from '../../../core/api/bff';

interface IPackageCollection {
    id: string;
    title: string;
}

/** Загрузить коллекции пакетов. */
export const fetchPackageCollections = createAsyncThunk('packages/fetchCollections', async (): Promise<IPackageCollection[]> =>
    bffApi.listPackageCollections(),
);

/**
 * Загрузить пакеты коллекции.
 *
 * @param {object} params
 * @param {string} params.collectionId
 */
export const fetchPackages = createAsyncThunk('packages/fetchPackages', async (params: { collectionId: string }) =>
    bffApi.listPackages(params),
);
