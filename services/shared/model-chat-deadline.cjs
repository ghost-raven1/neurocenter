'use strict';
/** Each enclosing transport leaves time for the bounded chat round to return its saved result. */
const assert = require('node:assert/strict');
const { deadlineLadder } = require('./deadline-ladders.mjs');
const FROZEN = require('./model-chat-deadline.json');
const [roundTimeoutMs, gatewayTimeoutMs, edgeTimeoutMs, clientTimeoutMs] = deadlineLadder(
    'model-chat',
    900000,
    [10000, 5000, 5000],
);
// model-chat-deadline.json is the frozen anchor: the formula must reproduce it exactly.
assert.deepEqual(
    { roundTimeoutMs, gatewayTimeoutMs, edgeTimeoutMs, clientTimeoutMs },
    FROZEN,
    'model-chat ladder drifted from model-chat-deadline.json',
);
module.exports = {
    MODEL_CHAT_ROUND_TIMEOUT_MS: roundTimeoutMs,
    MODEL_CHAT_GATEWAY_TIMEOUT_MS: gatewayTimeoutMs,
    MODEL_CHAT_EDGE_TIMEOUT_MS: edgeTimeoutMs,
    MODEL_CHAT_CLIENT_TIMEOUT_MS: clientTimeoutMs,
};
