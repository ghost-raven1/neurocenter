import express from 'express';
import { matchPolicy } from './route-policy';

/** The transport envelope must also fit around Catalog's bounded 512 KiB result.
 *  AD-6: лимит тела device-канала (600 KiB) — из строки /api/device-channel/* route-политики. */
export const deviceChannelJson = express.json({ limit: matchPolicy('POST', '/api/device-channel/identity').maxBodyBytes! });
