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

### POST /api/admin/round/start

Starts round 1 or round 2. Reveals the first prompt and starts the countdown timer.

Params (JSON body, optional):
- `round` or `roundNumber` (optional, integer: `1` or `2`). If omitted, defaults to round 1 (or round 2 if round 1 has completed).

```json
{
  "success": true,
  "message": "Round 1 started",
  "round": 1,
  "currentPrompt": {
    "id": 1,
    "title": "Reverse a Linked List",
    "description": "Solve in O(N)",
    "displayOrder": 1
  },
  "secondsRemaining": 60,
  "status": "bidding"
}
```

Errors:
- `400` Round already in progress
- `400` No prompts found (add prompts first)
- `400` No active teams found (add teams first)
- `400` Invalid round number (must be 1 or 2)
- `400` Round 1 must be completed before starting Round 2
- `400` All teams already assigned (Round 2 not needed)
- `400` No prompts have open slots remaining for Round 2

### POST /api/admin/round/pause

Freezes the current bidding timer and sets game status to `paused`.

No body params.

```json
{
  "success": true,
  "message": "Round paused",
  "round": 1,
  "secondsRemaining": 42,
  "status": "paused"
}
```

Errors:
- `400` Round is not actively bidding
- `400` Round is already paused

### POST /api/admin/round/resume

Resumes the frozen timer and restores game status to `bidding`.

No body params.

```json
{
  "success": true,
  "message": "Round resumed",
  "round": 1,
  "secondsRemaining": 42,
  "status": "bidding"
}
```

Errors:
- `400` Cannot resume: round is not paused

### POST /api/admin/round/extend

Adds extra seconds to the current countdown timer. Works while actively bidding or paused.

Params (JSON body):
- `extraSeconds` or `seconds` (required, positive integer): number of seconds to add.

```json
{
  "success": true,
  "message": "Timer extended by 30 seconds",
  "extraSeconds": 30,
  "secondsRemaining": 72
}
```

Errors:
- `400` `extraSeconds` must be a positive integer
- `400` Cannot extend timer: no prompt is currently active

### POST /api/admin/round/next-prompt

Force skips bidding on the current prompt: evaluates all placed bids, assigns winning teams their prompt with calculated multipliers, and advances to the next eligible prompt (or ends the round if this was the last prompt).

No body params.

Advancing response:
```json
{
  "success": true,
  "message": "Advanced to next prompt",
  "round": 1,
  "prompt": {
    "id": 2,
    "title": "Two Sum Variation",
    "description": "Find pairs in O(N)",
    "displayOrder": 2
  },
  "promptIndex": 1,
  "totalPrompts": 4,
  "winners": [
    {
      "teamId": 1,
      "teamName": "Alpha",
      "bidMinutes": 45,
      "multiplier": 1.868
    }
  ]
}
```

Round ended response (if last prompt or all teams assigned):
```json
{
  "success": true,
  "message": "Round ended - no more prompts",
  "round": 1,
  "status": "round_ended",
  "winners": [],
  "summary": {
    "round": 1,
    "assignedTeams": 8,
    "unassignedTeams": 2
  }
}
```

Errors:
- `400` Cannot advance prompt: no round in progress

### POST /api/admin/round/end

Force ends the current active or paused round immediately. Evaluates any bids placed on the current prompt, stops timer, updates status to `round_ended`, and provides a summary.

No body params.

```json
{
  "success": true,
  "message": "Round 1 ended",
  "round": 1,
  "status": "round_ended",
  "winners": [],
  "summary": {
    "round": 1,
    "assignedTeams": 8,
    "unassignedTeams": 2
  }
}
```

Errors:
- `400` No round is currently in progress

---

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

## Team Bidding (team only)

### GET /api/bid/current

Returns the current active prompt, countdown timer, existing bids on the prompt, and the calling team's placed bid.

No body params.

```json
{
  "success": true,
  "status": "bidding",
  "currentRound": 1,
  "currentPrompt": {
    "id": 1,
    "title": "Reverse a Linked List",
    "description": "Solve in O(N)",
    "displayOrder": 1
  },
  "secondsRemaining": 48,
  "isPaused": false,
  "bids": [
    {
      "teamId": 2,
      "teamName": "Beta",
      "bidMinutes": 60,
      "submittedAt": "2026-10-24T15:00:12.000Z"
    }
  ],
  "myBid": null,
  "hasAssignment": false,
  "assignment": null
}
```

### POST /api/bid/place

Places a time commitment bid in minutes for the currently active prompt. Only permitted when round status is `bidding`. Enforces anti-collision: no duplicate bids on the same prompt within the same round.

Params (JSON body):
- `bidMinutes` (required, integer between `minBid` and `baseTime`, e.g. 30 to 120).

```json
{
  "success": true,
  "message": "Bid placed successfully",
  "bid": {
    "id": 1,
    "teamId": 1,
    "teamName": "Alpha",
    "promptId": 1,
    "bidMinutes": 45,
    "round": 1,
    "submittedAt": "2026-10-24T15:00:15.000Z"
  }
}
```

Errors:
- `400` Missing or invalid bid time (must be integer within range)
- `400` Bidding is not currently active / round paused
- `400` Team has already been assigned a prompt
- `400` Team has already placed a bid for this prompt (use update endpoint)
- `403` Team has been deactivated
- `409` A bid of X minutes has already been placed by another team

### PUT /api/bid/update

Updates an existing bid placed by this team on the active prompt before timer ends.

Params (JSON body):
- `bidMinutes` (required, integer between `minBid` and `baseTime`, must differ from current bid).

```json
{
  "success": true,
  "message": "Bid updated successfully",
  "bid": {
    "id": 1,
    "teamId": 1,
    "teamName": "Alpha",
    "promptId": 1,
    "bidMinutes": 40,
    "round": 1,
    "submittedAt": "2026-10-24T15:00:25.000Z"
  }
}
```

Errors:
- `400` New bid must be different from current bid
- `404` No existing bid found to update for this prompt
- `409` A bid of X minutes has already been placed by another team

### GET /api/bid/my-bids

Returns all bids placed by the calling team across all rounds and prompts.

No body params.

```json
{
  "success": true,
  "bids": [
    {
      "id": 1,
      "promptId": 1,
      "promptTitle": "Reverse a Linked List",
      "displayOrder": 1,
      "round": 1,
      "bidMinutes": 40,
      "submittedAt": "2026-10-24T15:00:25.000Z"
    }
  ]
}
```

### GET /api/bid/assignment

Retrieves the team's assigned prompt, time commitment, and computed multiplier. Returns `assignment: null` if no prompt has been assigned yet.

No body params.

```json
{
  "success": true,
  "assignment": {
    "id": 1,
    "teamId": 1,
    "promptId": 1,
    "title": "Reverse a Linked List",
    "description": "Solve in O(N)",
    "displayOrder": 1,
    "bidMinutes": 40,
    "round": 1,
    "multiplier": 1.948,
    "codingTimeMinutes": 40,
    "assignedAt": "2026-10-24T15:01:00.000Z"
  }
}
```

### GET /api/bid/leaderboard

Returns the full leaderboard with rankings and final scores for authenticated teams.

No body params.

---

## Unauthenticated responses

Any protected endpoint without a valid token returns:

- `401` `{ "message": "Authentication token is missing" }`
- `401` `{ "message": "Authentication token has expired" }`
- `401` `{ "message": "Invalid authentication token" }`
- `403` `{ "message": "This endpoint is restricted to <role> accounts" }` (wrong role)
