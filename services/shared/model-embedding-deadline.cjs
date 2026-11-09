'use strict';
/** The catalog embedding call runs under the client timer: upstream must give up first. */
const { deadlineLadder } = require('./deadline-ladders.mjs');
const [upstreamTimeoutMs, clientTimeoutMs] = deadlineLadder('embedding', 110000, [5000]);
module.exports = {
    EMBEDDING_UPSTREAM_TIMEOUT_MS: upstreamTimeoutMs,
    EMBEDDING_CLIENT_TIMEOUT_MS: clientTimeoutMs,
};
