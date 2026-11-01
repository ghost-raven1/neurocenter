import type { TFeatureFlagKey } from '../../../shared/feature-flags.cjs';

export const CHAT_SEARCH_FEATURES: TFeatureFlagKey[] = ['system_indexer', 'project_chat', 'rag_sync', 'model_hosting'];

export const CHAT_SEARCH_CHUNK = 2048;

export const CHAT_SEARCH_SCAN_CAP = 10000;
