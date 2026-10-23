'use strict';
/** Each enclosing transport leaves time for the bounded chat round to return its saved result. */
const {roundTimeoutMs:MODEL_CHAT_ROUND_TIMEOUT_MS,gatewayTimeoutMs:MODEL_CHAT_GATEWAY_TIMEOUT_MS,
    edgeTimeoutMs:MODEL_CHAT_EDGE_TIMEOUT_MS,clientTimeoutMs:MODEL_CHAT_CLIENT_TIMEOUT_MS}=require('./model-chat-deadline.json');
module.exports={MODEL_CHAT_ROUND_TIMEOUT_MS,MODEL_CHAT_GATEWAY_TIMEOUT_MS,MODEL_CHAT_EDGE_TIMEOUT_MS,MODEL_CHAT_CLIENT_TIMEOUT_MS};
