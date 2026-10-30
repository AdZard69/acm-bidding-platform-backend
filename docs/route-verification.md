# Backend route verification and timeout repair

All **42 registered HTTP method/path combinations** have a successful behavior
check in `tests/unit/routes.test.js`. The suite discovers routes from the actual
Express stack and fails if a registration lacks a successful request.

Requests pass through Node's HTTP parser, Express routing, JSON parsing,
JWT/role middleware, controllers, services, bcrypt, and error handling. The
persistence boundary is an in-memory Prisma substitute with unique/foreign-key
constraints and transaction rollback. These are not live PostgreSQL results.

| Method | Path | Behavior asserted |
| --- | --- | --- |
| GET | `/api/health` | Liveness succeeds even during database failure |
| GET | `/api/health/ready` | Database readiness succeeds or returns 503 |
| GET | `/api/clock` | Uncached bidding status and clock metadata |
| GET | `/api/clock/sync` | Echoes client time and server receive/transmit times |
| POST | `/api/clock/sync` | Same synchronization through JSON body |
| POST | `/api/auth/team/login` | Valid team token, bad credentials and invalid types |
| POST | `/api/auth/admin/login` | Valid admin token, bad credentials and invalid types |
| GET | `/api/auth/me` | Authenticated identity and role |
| POST | `/api/auth/logout` | Stateless logout acknowledgement |
| POST | `/api/auth/team/change-password` | Verifies current password; future logins use new password |
| POST | `/api/auth/admin/change-password` | Same password change for admins |
| GET | `/api/admin/bids` | Persisted bids include team and prompt context |
| GET | `/api/admin/teams` | Lists safe records without password hashes |
| POST | `/api/admin/teams` | Creates team; validates input and duplicate names |
| PUT | `/api/admin/teams/:id` | Updates name, password and boolean active flag |
| DELETE | `/api/admin/teams/:id` | Removes a team; missing IDs return 404 |
| PATCH | `/api/admin/teams/:id/toggle` | Flips active status |
| GET | `/api/admin/prompts` | Lists stored prompts |
| POST | `/api/admin/prompts` | Creates prompt and computes omitted display order |
| PUT | `/api/admin/prompts/:id` | Updates content/order; blocked during bidding |
| DELETE | `/api/admin/prompts/:id` | Deletes prompt and its dependent bids, assignments and scores; preserves other prompts' data |
| POST | `/api/admin/round/start` | Starts first prompt and one bidding session |
| POST | `/api/admin/round/pause` | Freezes remaining time and closes bid acceptance |
| POST | `/api/admin/round/resume` | Continues the same session |
| POST | `/api/admin/round/extend` | Extends paused time; rejects invalid/stale session inputs |
| POST | `/api/admin/round/next-prompt` | Manually closes the current round, opens the next prompt round once, and rejects a stale session |
| POST | `/api/admin/round/end` | Closes the current round, retains its prompt/bids/results and waits for admin Next |
| POST | `/api/admin/scores/:teamId` | Requires assignment; calculates/overrides score atomically with audit log |
| GET | `/api/admin/leaderboard` | Consistent numeric scores and ranking |
| POST | `/api/admin/reset` | Validates wipe flags; transaction clears state and rolls back on failure |
| GET | `/api/admin/config` | Returns persisted configuration |
| PUT | `/api/admin/config` | Stores settings; validates types, limits and active-round restrictions |
| GET | `/api/bid/current` | Shared prompt/bid/countdown snapshot; simultaneous reads coalesce |
| GET | `/api/bid/leaderboard` | Public standings match admin ranking for active teams, including zero scores |
| POST | `/api/bid/place` | Accepts team bid; rejects collisions, invalid ranges, stale sessions and late bids |
| POST | `/api/bid` | Compatible bid placement alias |
| PUT | `/api/bid/update` | Updates the existing bid |
| PUT | `/api/bid` | Compatible bid update alias |
| GET | `/api/bid/my-bids` | Returns the calling team's bid history |
| GET | `/api/bid/assignment` | Returns assignment and numeric score for reload recovery |
| GET | `/api/docs` | Serves Swagger UI |
| GET | `/api/docs.json` | Serves the OpenAPI document |

Protected registrations are also exercised without credentials and with the wrong
role. Every database-dependent route is exercised with an injected Prisma P1008
error and must answer with sanitized HTTP 503, a useful error code, and
`Retry-After`. Socket admin/bid acknowledgements use the same error classifier.

## Repairs for widespread timeouts

- Configuration reads use SELECT instead of rewriting the singleton row on every
  request. Concurrent configuration/state reads share in-flight work.
- Active bids reuse the persisted session configuration and rely on the database
  uniqueness constraint for collisions, reducing repeated database round trips.
- Admin CRUD notifications no longer fetch another database snapshot while holding
  the mutation queue. The frontend refreshes on a cheap notification and coalesces
  duplicate admin reloads.
- Queue entries have a bounded admission wait and capacity. Expired queued writes
  are removed and never execute later. Running writes retain queue ownership
  until they settle; a timeout cannot accidentally let an old bid race awards.
- Prisma's PostgreSQL driver receives connection/pool/query timeout settings. A
  cooperative operation deadline refuses subsequent queries after the request's
  budget. This does not pretend to cancel a database write with Promise.race.
- Score submission forwards queue rejection to Express's error handler. Previously
  that rejection could escape Express 4 and leave the HTTP request unanswered.
- Startup exposes readiness failures and retries initialization instead of
  accepting a database request flood before bootstrap/recovery finishes.
- Score/audit writes and destructive resets are transactional. A failed reset
  preserves its rows and the running timer. Database errors cannot cause a string
  `"false"` wipe flag to delete data.

Runtime defaults are 5 connections, 5 seconds to connect, 3 seconds for pool
acquisition, 3 seconds for a database query, a 10-second cooperative operation
budget, and a 3-second game queue wait. Explicit connection URL parameters take
precedence. The supported driver URL parameters are documented in the
[Prisma PostgreSQL reference](https://www.prisma.io/docs/orm/v6/overview/databases/postgresql).
These settings target the installed Prisma 5 driver, not Prisma 7 adapters.

## Commands and verification boundary

```bash
npm run test:routes  # complete HTTP route matrix and failure scenarios
npm run test:unit    # route suite, bidding flow, timers, auth utilities and timeout tests
npm run db:check     # read-only connection and persisted timer schema check
npm test            # original PostgreSQL + network integration tests; requires DATABASE_URL_TEST
```

The workspace blocks database TCP access. The configured Supabase check returns
P1001 here, and the original PostgreSQL suite cannot reach `localhost:5432`.
Neither result establishes that those hosts are down outside this sandbox.
Live PostgreSQL correctness/connectivity remains unverified here. Run
`npm run db:check` in the actual backend host; use `/api/health/ready` for
readiness and `/api/health` for liveness. Run the full integration suite against a
separate test database after connectivity is available.

Manual-round regressions additionally cover expiry without advancement, closed
round recovery after restart, equal multiplier curves, legacy round-1 history
projection, and per-round bid filtering over HTTP.
