# API Routes

Base URL: `http://localhost:5000/api`

Interactive Swagger docs: **http://localhost:5000/api/docs** (spec at `/api/docs.json`, source: `docs/openapi.json`)

All responses follow the shape `{ "success": true/false, ... }`. Errors return:

```json
{ "success": false, "error": { "message": "..." } }
```

Authenticated requests need a JWT returned by login:

```
Authorization: Bearer <token>
```

The `Authorization: Bearer <token>` header is also set on the login **response**, so
clients may grab the token from the header or body (the header is CORS-exposed).

---

## Public

### GET /api/health

Server health check. No params.

```json
{ "success": true, "status": "ok", "uptime": 12.34 }
```

### POST /api/auth/team/login

Params (JSON body): `teamName` (string, required), `password` (string, required).

```json
{ "success": true, "token": "eyJ...", "teamId": 1, "teamName": "Alpha" }
```

Errors: `400` missing fields, `401` wrong credentials, `403` team deactivated.

### POST /api/auth/admin/login

Params (JSON body): `username` (string, required), `password` (string, required).

```json
{ "success": true, "token": "eyJ...", "role": "admin", "adminId": 1, "username": "admin" }
```

Errors: `400` missing fields, `401` wrong credentials.

---

## Any authed role

### GET /api/auth/me

No params. Requires any valid token. Returns the token's identity:

```json
{ "success": true, "sub": "1", "role": "team", "teamId": 1, "teamName": "Alpha" }
```

admin token instead returns `role`, `adminId`, `username`.

### POST /api/auth/logout

No params. Requires any valid token. Tokens are stateless; the client should discard it.

```json
{ "success": true, "message": "Logged out. Discard the token on the client side." }
```

---

## Team only

### POST /api/auth/team/change-password

Requires a team token. Params (JSON body): `currentPassword`, `newPassword` (both required; new min 6 chars, max 72, must differ from current).

```json
{ "success": true, "message": "Password updated", "teamId": 1, "teamName": "Alpha" }
```

Errors: `400` validation, `401` wrong current password, `404` team not found.

---

## Admin only

### POST /api/auth/admin/change-password

Requires an admin token. Params (JSON body): `currentPassword`, `newPassword` (same rules as above).

```json
{ "success": true, "message": "Password updated", "adminId": 1, "username": "admin" }
```

### GET /api/admin/teams

No params. Lists all teams.

```json
{
  "success": true,
  "teams": [
    { "id": 1, "teamName": "Alpha", "isActive": true, "createdAt": "2026-10-23T17:16:30.792Z" }
  ]
}
```

### POST /api/admin/teams

Params (JSON body): `teamName` (string, required), `password` (string, required, min 4 chars). Creates a new team.

```json
{ "success": true, "team": { "id": 3, "teamName": "Beta", "isActive": true, "createdAt": "..." } }
```

Errors: `400` validation, `409` name already exists.

### PUT /api/admin/teams/:id

Param `:id` — team id in the URL path. Params (JSON body), all optional but at least one required: `teamName`, `password` (min 4), `isActive` (boolean).

```json
{ "success": true, "team": { "id": 3, "teamName": "Betta", "isActive": false, "createdAt": "..." } }
```

Errors: `400` nothing to update / validation, `404` unknown id, `409` name clash.

### DELETE /api/admin/teams/:id

Param `:id` — team id in the URL path. Removes the team and its bids, assignment, and score.

```json
{ "success": true, "message": "Team removed" }
```

Errors: `404` unknown id.

### PATCH /api/admin/teams/:id/toggle

Param `:id` — team id in the URL path. Flips `isActive` on/off. Deactivated teams are rejected at login with 403.

```json
{ "success": true, "team": { "id": 3, "teamName": "Betta", "isActive": true } }
```

Errors: `404` unknown id.

---

## Prompts (admin only)

### GET /api/admin/prompts

No params. Lists all prompts sorted by `displayOrder`.

```json
{
  "success": true,
  "prompts": [
    { "id": 1, "title": "Prompt A", "description": "...", "displayOrder": 1, "createdAt": "..." }
  ]
}
```

### POST /api/admin/prompts

Params (JSON body): `title` (required, ≤ 100 chars), `description` (required), `displayOrder` (optional, positive integer).

If `displayOrder` is omitted it auto-assigns `max + 1`, so prompts appear in creation order.

```json
{ "success": true, "prompt": { "id": 2, "title": "Prompt B", "description": "...", "displayOrder": 2, "createdAt": "..." } }
```

Errors: `400` validation.

### PUT /api/admin/prompts/:id

Param `:id` — prompt id in the URL path. Params (JSON body), all optional but at least one required: `title` (≤ 100 chars), `description`, `displayOrder` (positive integer).

```json
{ "success": true, "prompt": { "id": 1, "title": "Prompt A2", "description": "...", "displayOrder": 5, "createdAt": "..." } }
```

Errors: `400` nothing to update / validation / invalid id, `404` unknown id.

### DELETE /api/admin/prompts/:id

Param `:id` — prompt id in the URL path. Removes the prompt and its bids and assignments.

```json
{ "success": true, "message": "Prompt removed" }
```

Errors: `400` invalid id, `404` unknown id.

---

## Round Controls (admin only)

Round numbers identify prompts in captured display order: Round 1 = Prompt 1,
Round 2 = Prompt 2, etc. There are no repeated passes across all prompts.
Every round uses the same score multiplier curve.

### POST /api/admin/round/start

Accepts optional `{ "roundNumber": N }` (or `round`). Opens the next sequential
prompt round; defaults to Round 1 initially. Completed rounds cannot be replayed
and future rounds cannot be skipped. Returns the complete bidding snapshot.

### POST /api/admin/round/pause

Freezes the current active countdown. Optional `{ "timerId": "..." }` rejects a
request from a stale screen. Bids are rejected while paused.

### POST /api/admin/round/resume

Continues the same paused countdown and session ID.

### POST /api/admin/round/extend

Accepts `{ "extraSeconds": 15, "timerId": "..." }` (`seconds` is also accepted).
Adds time to a running or paused timer. A completed round cannot be extended.

### POST /api/admin/round/next-prompt

Only this admin action opens the next prompt round. If the current round is still
running or paused, it first closes the round and awards its winners. If expiry
already closed it, the saved result is reused. It then starts Round N+1 on Prompt
N+1 with a new session. At the last round, it closes bidding without opening
another prompt. Concurrent stale clicks are rejected.

The response is the new prompt's snapshot; `completedRound` includes the previous
round number, prompt ID, winners and summary when another prompt was opened.

### POST /api/admin/round/end

Closes and awards the current round and waits for the admin to click Next. It does
not open another prompt. Timer expiry has the same stop-and-wait behavior.

Closed snapshots keep `currentPrompt`, `bids`, `winners`, `summary`, `timerId` and
round metadata, with zero remaining time. Refresh and restart retain this view.

### GET /api/admin/bids?round=N

Lists only the requested prompt round's persisted bids. Omit `round` to return
all history. Legacy records stored under one bidding pass are labelled by their
prompt round without deleting or rewriting them.

## Scores & Leaderboard (admin only)

### POST /api/admin/scores/:teamId

Submits or overrides a judge score for an assigned team. Automatically calculates final score using the team's prompt multiplier (`finalScore = judgeScore * multiplier`).

Param `:teamId` — team id in URL path (positive integer).

Params (JSON body):
- `judgeScore` (required, integer between `0` and `100`).

```json
{
  "success": true,
  "message": "Score submitted successfully",
  "score": {
    "id": 1,
    "teamId": 2,
    "teamName": "Beta",
    "judgeScore": 85,
    "multiplier": 1.792,
    "finalScore": 152.32,
    "scoredAt": "2026-10-24T15:00:00.000Z"
  }
}
```

Errors:
- `400` Invalid team id / missing or invalid judge score
- `400` Team has not been assigned a prompt yet
- `404` Team not found

### GET /api/admin/leaderboard

Returns the full leaderboard sorted by final score descending (scored teams first), with judge scores, multipliers, and assigned prompts.

No params.

```json
{
  "success": true,
  "leaderboard": [
    {
      "rank": 1,
      "teamId": 2,
      "teamName": "Beta",
      "isActive": true,
      "prompt": {
        "id": 1,
        "title": "Reverse a Linked List",
        "displayOrder": 1
      },
      "bidMinutes": 50,
      "multiplier": 1.792,
      "judgeScore": 85,
      "finalScore": 152.32,
      "scoredAt": "2026-10-24T15:00:00.000Z"
    }
  ]
}
```

---

## Game Reset (admin only)

### POST /api/admin/reset

Nuclear option: resets game state back to `waiting`. Wipes all placed bids, awarded assignments, and judge scores. Stops any active timer.

Optional body params:
- `wipeTeams` (boolean): also delete all teams
- `wipePrompts` (boolean): also delete all prompts
- `wipeAll` (boolean): delete both teams and prompts

```json
{
  "success": true,
  "message": "Game reset successfully",
  "status": "waiting"
}
```

---

## Game Configuration (admin only)

### GET /api/admin/config

Returns current game settings.

No params.

```json
{
  "success": true,
  "config": {
    "id": 1,
    "baseTime": 120,
    "minBid": 30,
    "maxTeams": 10,
    "slotsPerPrompt": 3,
    "bidDurationSeconds": 60,
    "currentRound": 0,
    "currentPromptIndex": -1,
    "status": "waiting",
    "updatedAt": "2026-10-24T15:00:00.000Z"
  }
}
```

### PUT /api/admin/config

Updates game configuration settings. Only allowed when no round is in progress (`waiting` or `round_ended`).

Params (JSON body, at least one required):
- `baseTime` (optional, positive integer): maximum bid and starting reference time in minutes
- `minBid` (optional, positive integer): minimum allowable bid in minutes (must not exceed `baseTime`)
- `maxTeams` (optional, integer between `1` and `50`): maximum team capacity
- `slotsPerPrompt` (optional, integer `>= 1`): winners allowed per prompt
- `bidDurationSeconds` (optional, integer `>= 10`): bidding countdown duration per prompt

```json
{
  "success": true,
  "message": "Game configuration updated successfully",
  "config": {
    "id": 1,
    "baseTime": 100,
    "minBid": 25,
    "maxTeams": 12,
    "slotsPerPrompt": 4,
    "bidDurationSeconds": 45,
    "currentRound": 0,
    "currentPromptIndex": -1,
    "status": "waiting",
    "updatedAt": "2026-10-24T15:30:00.000Z"
  }
}
```

Errors:
- `400` Nothing to update / validation error / `minBid` exceeds `baseTime`
- `400` Cannot update game settings while a round is in progress

---

## Unauthenticated responses

Any protected endpoint without a valid token returns:

- `401` `{ "message": "Authentication token is missing" }`
- `401` `{ "message": "Authentication token has expired" }`
- `401` `{ "message": "Invalid authentication token" }`
- `403` `{ "message": "This endpoint is restricted to <role> accounts" }` (wrong role)


## Bidding integration

See [shared bidding countdown](client-clock-sync.md) for the current snapshot,
session-aware bid inputs, restart behavior and deployment steps.

- `GET /api/bid/current` — public prompt, bids, countdown and configured limits.
- `POST /api/bid/place`, `PUT /api/bid/update` — team bid mutations; include
  `bidMinutes`, `promptId`, `round`, and `timerId` from the viewed snapshot.
- `GET /api/bid/assignment` — team assignment and score for refresh/reconnect.
- `GET /api/bid/my-bids` — the calling team's bid history.
- `GET /api/bid/leaderboard` — public standings for active teams.
- `GET /api/admin/bids` — admin-only persisted bid history with prompt/team names.

Timer controls accept `timerId` to reject actions from a stale view. They publish
one complete `game:status` snapshot to all clients after each successful change.
Prompt edits are rejected while bidding is active or paused.
