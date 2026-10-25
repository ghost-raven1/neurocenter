# Device MCP lifecycle v2

The independent MCP lane does not block ordinary device jobs or cloud model chats.
One admitted session owns its transport, private temporary HOME and local process
chain. The bridge advertises `system-role-mcp-v2` only where this lifecycle is
implemented. Windows is currently unsupported for this lane; other jobs remain
available. macOS and Linux require separate native acceptance.

## Claim and crash recovery

Before sending a claim, the bridge fsyncs an intent scoped to the site, API origin,
physical profile device/inode/birth, device ID and credential hash. It never stores the token
in the journal. A fresh claim is sent once:
`{requestId: UUID, recoveryOnly: false}`. An idle null response needs no retained
server row. After an uncertain response or restart, only
`{requestId: same UUID, recoveryOnly: true}` may be sent. Recovery never allocates
a new session and never authorizes tool execution. The server durably retires
explicit recovery nonces under the device lock, so a late original request cannot
allocate after recovery returned null. This is not general replay semantics for
arbitrary fresh requests which returned idle null.

A known lease is fsynced before resolving the local target. Its private HOME path
is derived from the intent's random nonce before mkdir. The stdio guardian starts
without tool credentials and cannot execute until the bridge fsyncs its exact
PID, UID, birth and entry and then sends a one-use IPC permit. A disconnected
bridge causes the guardian to run its own cleanup.

The guardian tracks its discovered descendants, including detached browser groups.
On shutdown it freezes that tree, rechecks UID and birth before signals, waits for
the recorded processes to disappear, fsyncs a closure receipt and exits. Restart
recovery reconciles the recorded guardian or an unpermitted wrapper by exact nonce;
it does not reconnect or replay the tool. No unrelated PID is killed.

## Physical completion and delivery

`authorize.closed === true` aborts the held session. Cleanup attempts both transport
and HOME even when the first fails. `closed: true` is returned only after awaited
local cleanup. The poller then fsyncs the exact completion body before HTTP:
`{jobId, lease, state, message, result:{schemaVersion:1, sessionId, closed:true}}`.
Only an explicit `{ok:true, closed:true}` removes those bytes. Lost acknowledgements
or restart resend the same completion, without running the tool. Server result,
expiry or session cancellation never substitute for this physical acknowledgement.

Cancellation cannot cancel an in-flight filesystem commit. The poller drains that
session's owner write before publishing completion or releasing its active slot,
including when execution throws. A late rename cannot recreate an acknowledged
or retired session, and another session keeps its own independent write fence.

Server `worker_closed_at` remains unset until the exact retained token and immutable
lease acknowledge cleanup. Token rotation is fenced until then. If the server
accepted a completion but its HTTP response was lost, a later token change archives
the already durable closed proof under the old scope; it is never sent using a
replacement token. Uncertain tool-result receipts remain separately preserved.

## Limits

The receipt proves the local MCP transport chain and the descendants observed by
the guardian have stopped. It is not OS containment against an adversarial daemon
which double-forks outside observation, nor proof that a remote side effect was
cancelled. Dispatched remote results stay unknown; unreachable remote cleanup does
not indefinitely hold the local worker. Killing the guardian itself before its
closure receipt is fail-closed: that particular local MCP session needs inspection
and cannot acknowledge physical cleanup merely because its parent PID disappeared.
Ordinary jobs and independent chats retain their separate lifecycle.
