# Shared bidding countdown

Starting a round starts a countdown for the first prompt on the backend. Every
new prompt gets its own `timerId`, round number and countdown. Admin, team and arena views show
that countdown. They do not display the server's time of day.

## Time and synchronization

- The backend measures elapsed time with `performance.now()`. Changing the server
  date/time cannot change the duration of an auction already running.
- Start/rerun first persist a frozen timer, then activate and immediately publish
  the full configured duration. Database preparation cannot consume the first
  20 seconds of a 60-second auction. Resume uses the same preparation step to
  retain its exact paused milliseconds. Audit writes do not delay publication.
- `GET /api/bid/current` returns one uncached snapshot containing status, round,
  prompt, bids, configured limits, available slots and timer details.
- Every timer mutation publishes that same complete shape as `game:status`.
- `timer:tick` broadcasts `timerId`, `promptId`, `currentRound`, `remainingMs`,
  `elapsedMs`, `durationSeconds`, `secondsRemaining`, and pause/running flags.
  Clients ignore ticks from a different timer session.
- Snapshots include `timerStreamId`, an increasing `timerSequence`, and
  `serverMonotonicTime`. Sequence ordering prevents stale packets from rewinding
  the display even if the server's wall clock changes. A new process has a new
  stream ID.
- Round N identifies Prompt N in the captured display order. At expiry, the server
  awards the current round and stores `round_ended`; it does not start another
  timer. The prompt, bids and winners remain visible until admin Next.
- `rounds`, `totalRounds`, `hasNextRound` and `nextRoundNumber` describe the sequence.
  A closed snapshot retains its timer session ID, winners and summary so refresh
  and restart cannot accidentally skip or re-award the completed round.
- The browser anchors `remainingMs` to its own `performance.now()`. Socket pings
  include a server monotonic timestamp; clients estimate transit time and age
  delayed snapshots against that clock instead of restarting an old countdown.
  It refreshes the snapshot
  on connection, reconnect, tab visibility, and periodically. Display agreement
  is subject to network latency and browser scheduling; the backend decides
  whether a bid is accepted.
- A connected viewer receives 60 seconds at a fresh start. A late join or
  reconnect displays the server's actual remaining time, rather than resetting
  that browser to 60. Successful admin responses update the initiating view
  immediately, without waiting for another database-backed refresh.
- Pausing freezes exact remaining milliseconds. An extension increases both
  remaining time and total duration, including while paused. Resume continues
  the same timer session. Finishing or resetting clears the countdown.
- Absolute timestamps and `/api/clock` remain available for diagnostics and
  compatibility. The app does not use wall-clock offsets to run its countdown.

Example active snapshot (additional fields omitted):

```json
{
  "success": true,
  "status": "bidding",
  "currentRound": 1,
  "timerId": "5b090281-33c1-42c3-92eb-d4394cf58f37",
  "currentPrompt": { "id": 2, "title": "Prompt 2", "description": "Build...", "displayOrder": 2 },
  "remainingMs": 41520,
  "elapsedMs": 18480,
  "secondsRemaining": 42,
  "durationSeconds": 60,
  "isPaused": false,
  "availableSlots": 3,
  "config": { "baseTime": 120, "minBid": 30, "slotsPerPrompt": 3, "bidDurationSeconds": 60 },
  "bids": []
}
```

## Mutations and bid acceptance

The app sends each admin command once over HTTP. The server broadcasts its result
to all connected viewers, including other admins. Socket admin controls remain
supported through the same service functions.

HTTP `POST /api/bid/place` / `PUT /api/bid/update` and socket `bid:place` /
`bid:update` use one bid service. Send the viewed session with every bid:

```json
{ "bidMinutes": 45, "promptId": 2, "round": 1, "timerId": "5b090281-33c1-42c3-92eb-d4394cf58f37" }
```

The server checks active status, session identity, eligibility, configured limits,
minute collisions and expiry. It checks expiry again after database reads,
immediately before accepting the write. Accepted writes finish before winner
selection. Delayed bids cannot land on a different prompt or a later round.
Client-supplied countdowns, deadlines and device timestamps never decide expiry.
The server expires the auction with no connected browsers. Its expiry operation
has its own request budget and survives queue saturation; a start request's
expired HTTP budget cannot cancel it. A queued expiry rechecks the deadline so
it cannot close a timer that has since been extended.
Admin pause/resume/extend/next/end requests can also include `timerId` to reject
controls from a stale screen. Missing context remains accepted for older clients.

Bids and game mutations share one server queue. Queue admission is bounded;
expired waiting commands never execute later. Concurrent snapshot reads coalesce,
and cheap `game:refresh` notifications request a refresh without doing extra
broadcast queries under the mutation lock. Database uniqueness constraints
provide an additional collision guard. A socket acknowledgement timeout causes a
refresh and an explicit uncertain-result message; the client does not replay the
mutation over another transport.

Public sockets join as spectators; only authenticated admin/team sockets register
mutation handlers. HTTP private routes still require their respective JWT roles.

## Reload, disconnect, restart and reset

Team assignment and score are restored through `GET /api/bid/assignment`. That
response includes numeric `multiplier`/`finalScore` fields and the team's score.
Reset clears assignments, scores, bids and client state across connected views.
Admin/public leaderboards share ranking and tie-break rules; the public view
omits inactive teams. `GET /api/admin/bids` restores the full admin bid history,
including losing bids on earlier prompts, across browsers and reconnects.

`GameConfig.biddingState` persists the timer and the prompt order captured at
round start. Running timers consume downtime on restart; paused timers keep their
saved remaining milliseconds. Recovery across a process restart uses saved epoch
time to account for downtime, then switches to monotonic elapsed time. Existing
active games from older versions without a saved timer recover paused at the
configured duration because their former deadline cannot be reconstructed.

Activation checkpoints the actual running deadline asynchronously, using a JSON
compare to prevent a late write from replacing a newer pause, extension, reset
or rerun. If the process crashes before that checkpoint succeeds, the frozen
preparation record recovers paused. Admin Resume is then required; the server
does not guess when bidding began or silently grant a new running countdown.

The captured prompt order keeps Round N mapped to Prompt N throughout the event.
Bids and assignments created by the previous pass-based flow are projected into
prompt rounds when read; existing storage keys and earned scores are preserved.
A legacy active session can finish with its existing bids. New rounds store their
own round number. Every new award uses the same k=1 multiplier curve.
Prompt set/order changes require reset while rounds remain unfinished; content
edits remain blocked during active/paused bidding.

## Deploy and verify

Apply the included migration before starting this version:

```bash
npm run prisma:deploy
npm run prisma:generate
npm start
```

Run **one backend instance**. The countdown owner and mutation queue live in that
process. Multiple replicas require a shared timer owner, distributed write
ordering and Socket.IO event transport before scaling horizontally.

Frontend `VITE_API_URL` includes `/api`. When `VITE_SOCKET_URL` is omitted, sockets
use the API URL's origin. Set it explicitly if the socket host differs. Deploy the
frontend and backend changes together.

Checks:

```bash
# Backend: no database needed for unit and in-process transport/service tests
npm run test:unit
# Backend: real PostgreSQL and HTTP/WebSocket tests; requires DATABASE_URL_TEST
npm test
# Frontend
npm test
npm run build
```

The in-process suite checks shared HTTP/socket validation, collision ordering,
expiry during database reads, pause/extension snapshots, stale controls, expiry without
advancement, manual prompt rounds, restart recovery and assignment/score/reset
behavior. It does not replace testing PostgreSQL constraints or live network
connections in the full integration suite.

For driver timeout settings, readiness checks and the complete HTTP route matrix,
see [route verification and timeout repairs](route-verification.md).
