import express from 'express';

/** The transport envelope must also fit around Catalog's bounded 512 KiB result. */
export const deviceChannelJson = express.json({ limit: 600 * 1024 });
