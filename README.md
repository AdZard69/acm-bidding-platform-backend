# acm-bidding-platform-backend

backend + admin panel for "bid and code" — a hackathon format where teams bid on time commitments before coding.

---

## what is this

Round 1 is the first pass through all prompts in captured display order. Moving
to the next prompt keeps the round number. Once the pass is complete, the admin
can start Round 2 if teams remain unassigned and prompt slots remain open. Round 2
revisits prompts with free slots; bidding ends after that second pass. Assigned teams cannot bid again.

Each prompt has a server-owned countdown. At zero, bidding closes and winners are
assigned. The prompt, bids and results stay visible until the admin advances.
**Close Current Prompt** also closes and awards just that prompt. Next can close
the active prompt early, then open the next prompt or eligible pass.

Teams bid their coding time in minutes (defaults: 30–120). The lowest unique bids
win the configured slots, and each team receives at most one assignment. Admin
history groups every prompt's bids by bidding pass. Existing stored bids and
earned scores are preserved. Multiplier, boost and k details appear only in admin
views; team views show time commitments and scores.

after the minute is up, the 3 lowest bidders win that prompt and get pulled out of bidding. then the next prompt shows up and the remaining teams bid again. this goes on for all 4 prompts.

Round 1 uses k = 1.0; Round 2 uses k = 0.7.

once everyone has a prompt, teams code for the time they committed to. bid 45 mins? you get 45 mins. bid 80? you get 80. after time's up judges score your work out of 100, and your final score = judge score × multiplier.

the multiplier is where it gets spicy.

---

## the multiplying factor

this needed to be fair. like, genuinely fair — not just "lower bid = 10x score" type unfair. we went with an exponential curve that rewards aggressive bids but doesn't completely destroy conservative ones.

### formula

```
multiplier = e ^ (k × (1 - bid / base_time))
```

where:
- `base_time` = 120 minutes (the starting reference time / maximum bid)
- `bid` = whatever the team bid (minimum 30 mins, max 120 mins)
- `k` = 1.0 for round 1, 0.7 for round 2
- `e` = euler's number (~2.718)

### why this works

the exponent `(1 - bid/base_time)` gives us a value between 0 and 0.75 (since min bid is 30). when bid equals base time (120 mins), multiplier is exactly 1.0 — no advantage, no penalty. as the bid drops toward 30 mins, the multiplier climbs exponentially up to 2.117.

### round 1 multiplier table (k = 1.0)

| bid (mins) | multiplier | boost |
|-----------|-----------|-------|
| 120 | 1.000 | +0% |
| 110 | 1.087 | +8.7% |
| 100 | 1.181 | +18.1% |
| 90 | 1.284 | +28.4% |
| 80 | 1.396 | +39.6% |
| 70 | 1.517 | +51.7% |
| 60 | 1.649 | +64.9% |
| 50 | 1.792 | +79.2% |
| 40 | 1.948 | +94.8% |
| 30 | 2.117 | +111.7% |

### round 2 multiplier table (k = 0.7)

| bid (mins) | multiplier | boost |
|-----------|-----------|-------|
| 120 | 1.000 | +0% |
| 110 | 1.060 | +6.0% |
| 100 | 1.124 | +12.4% |
| 90 | 1.191 | +19.1% |
| 80 | 1.263 | +26.3% |
| 70 | 1.339 | +33.9% |
| 60 | 1.419 | +41.9% |
| 50 | 1.504 | +50.4% |
| 40 | 1.595 | +59.5% |
| 30 | 1.690 | +69.0% |

### fairness check

```text
Start Round 1 → Prompt 1 → Prompt 2 → ... → final prompt (all in Round 1)
Admin clicks Next → Round 2 → prompts with open slots, for unassigned teams
```

Every timer expiry waits for the admin. Pause and extend affect only the current
prompt's countdown. A new pass can start only after the previous pass finishes;
rerunning a pass clears its bids, assignments and scores across all its prompts.
Bidding has no further pass when all teams are assigned or no prompt slots remain.

## tech stack

| layer | tech | reason |
|-------|------|--------|
| runtime | Node.js | solid websocket support, fast enough for this |
| framework | Express | simple, everyone knows it |
| real-time | Socket.IO | handles reconnects, rooms, fallback — exactly what we need for live bidding |
| orm | Prisma | type-safe queries, auto-generated client, clean migrations |
| database | Supabase (PostgreSQL) | hosted postgres with a nice dashboard, free tier is more than enough |
| auth | JWT | team gets a token on login, admin gets a separate one with elevated role |
| deploy | Render | backend web service, supabase handles the db separately |

---

## database schema

schema lives in `prisma/schema.prisma`. 8 models:
- `Admin`: admin accounts for login and dashboard authorization
- `AdminLog`: audit log tracking all admin actions (timer controls, score overrides, config updates, reset)
- `Team`: team authentication and active/inactive status
- `Prompt`: problem statements and display ordering
- `Bid`: team bids per prompt per round with anti-collision constraint
- `Assignment`: awarded prompts, time commitment, and computed multiplier
- `Score`: judge evaluations and final multiplied score
- `GameConfig`: dynamic hackathon settings and live state

key constraints worth knowing:
- `@@unique([promptId, bidMinutes, round])` on Bid — prevents two teams from bidding the same minutes on the same prompt in the same round.
- `teamId` is `@unique` on Assignment — each team gets exactly one prompt.
- `username` is `@unique` on Admin and `teamName` is `@unique` on Team.
- GameConfig `status` tracks the game state: `waiting`, `bidding`, `paused`, `between_prompts`, `round_ended`, `coding`, `judging`, `finished`

---

## api routes

Interactive Swagger docs live at `/api/docs` (spec: `/api/docs.json`, source file `docs/openapi.json`).
The spec covers the routes implemented so far — auth, admin · teams, admin · prompts, admin · rounds.

### auth

```
POST /api/auth/team/login
  body: { teamName, password }
  returns: { token, teamId, teamName }

POST /api/auth/admin/login
  body: { username, password }
  returns: { token, role: "admin" }

GET  /api/auth/me                → identity behind the token (team or admin)
POST /api/auth/logout             → stateless, the client drops the token
POST /api/auth/team/change-password  → { currentPassword, newPassword }
POST /api/auth/admin/change-password → { currentPassword, newPassword }
```

send the token as `Authorization: Bearer <token>` on every protected route.

### admin routes (all require admin JWT)

```
GET    /api/admin/teams                → list all teams
POST   /api/admin/teams                → create a team { teamName, password }
PUT    /api/admin/teams/:id            → update team info
DELETE /api/admin/teams/:id            → remove team
PATCH  /api/admin/teams/:id/toggle     → activate/deactivate team

GET    /api/admin/prompts              → list all prompts
POST   /api/admin/prompts              → add a prompt { title, description }
PUT    /api/admin/prompts/:id          → edit prompt
DELETE /api/admin/prompts/:id          → remove prompt

POST   /api/admin/round/start          → open the next prompt in the current or next eligible pass
POST   /api/admin/round/pause          → pause current timer
POST   /api/admin/round/resume         → resume timer
POST   /api/admin/round/extend         → add time { extraSeconds }
POST   /api/admin/round/next-prompt    → manually open the next prompt or eligible pass
POST   /api/admin/round/end            → close and award the current prompt

PUT    /api/admin/config               → update game settings { baseTime, minBid, slotsPerPrompt, ... }
GET    /api/admin/config               → get current game settings

POST   /api/admin/scores/:teamId       → submit judge score { judgeScore }
GET    /api/admin/leaderboard          → full leaderboard with final scores
POST   /api/admin/reset                → nuclear option — reset everything for a fresh start
```

### team routes (require team JWT)

```
GET  /api/bid/current                  → get current prompt + timer + existing bids
POST /api/bid/place                    → place a bid { bidMinutes }
PUT  /api/bid/update                   → update your bid before timer ends { bidMinutes }
GET  /api/bid/my-bids                  → all bids this team has placed
GET  /api/bid/assignment               → get your assigned prompt + multiplier (after bidding ends)
GET  /api/bid/leaderboard              → public leaderboard (might restrict until judging is done)
```

---

## websocket events

this is where the real-time magic happens. using Socket.IO rooms — one room per team, one admin room, and a global broadcast room.

### server → everyone (broadcast)

```
timer:tick           → { secondsLeft, promptId }
bid:new              → { teamId, teamName, bidMinutes, promptId }
bid:updated          → { teamId, teamName, bidMinutes, promptId }
prompt:reveal        → { promptId, title, description, displayOrder }
prompt:results       → { promptId, winners: [{ teamId, teamName, bidMinutes, multiplier }] }
prompt:next          → { nextPromptIndex, totalPrompts }
round:started        → { roundNumber }
round:paused         → { secondsRemaining }
round:resumed        → { secondsRemaining }
round:ended          → { roundNumber, summary }
timer:extended       → { newSecondsLeft }
game:status          → { status, currentRound, currentPrompt }
```

### server → specific team

```
assignment:received  → { promptId, title, description, bidMinutes, multiplier, codingTimeMinutes }
score:received       → { judgeScore, multiplier, finalScore }
```

### client → server

```
bid:place            → { bidMinutes }
bid:update           → { bidMinutes }
```

### admin client → server

```
admin:start-round    → { roundNumber }
admin:pause          → {}
admin:resume         → {}
admin:extend         → { extraSeconds }
admin:next-prompt    → {}
admin:end-round      → {}
```

---

## project structure

this is a smol project so I will use mvc or simply different folders for each handling purpose rather than modules for each feat

```
acm-bidding-platform-backend/
├── prisma/
│   └── schema.prisma            ← prisma schema (models, relations, constraints)
├── src/
│   ├── config/
│   │   ├── env.js               ← dotenv + validation
│   │   └── prisma.js            ← prisma client instance
│   ├── constants/
│   │   ├── gameStatus.js        ← game state enums
│   │   └── socketEvents.js      ← socket event name constants
│   ├── controllers/
│   │   ├── adminController.js   ← admin business logic
│   │   ├── authController.js    ← login business logic
│   │   ├── bidController.js     ← bid business logic
│   │   └── scoreController.js   ← score & leaderboard logic
│   ├── middleware/
│   │   ├── auth.js              ← shared JWT verification + role gate
│   │   ├── authAdmin.js         ← verify admin JWT
│   │   ├── authSocket.js        ← socket handshake auth
│   │   ├── authTeam.js          ← verify team JWT
│   │   └── errorHandler.js      ← express error handler
│   ├── routes/
│   │   ├── admin.js             ← admin CRUD + round controls
│   │   ├── auth.js              ← login endpoints
│   │   ├── bid.js               ← team bidding endpoints
│   │   ├── index.js             ← api router aggregator
│   │   └── scores.js            ← score submission + leaderboard
│   ├── services/
│   │   ├── authService.js       ← login, password change, admin bootstrap
│   │   ├── bidEngine.js         ← winner selection, assignment logic
│   │   ├── gameService.js       ← round/prompt flow management
│   │   └── multiplierService.js ← the multiplier formula
│   ├── socket/
│   │   ├── adminHandler.js      ← admin socket events
│   │   ├── bidHandler.js        ← handle bid:place, bid:update
│   │   ├── index.js             ← socket.io init + rooms
│   │   └── timerManager.js      ← countdown logic, pause/resume/extend
│   ├── utils/
│   │   ├── apiError.js          ← http aware error type
│   │   ├── logger.js            ← console logging helper
│   │   ├── password.js          ← bcrypt hashing helpers
│   │   ├── token.js             ← JWT sign/verify helpers
│   │   └── validators.js        ← input validation helpers
│   └── server.js                ← express app + socket.io bootstrap
├── scripts/
│   └── migrate-test-db.js       ← applies migrations to the test database
├── tests/
│   ├── auth.integration.test.js ← auth endpoints against a real database
│   ├── unit/                    ← token + password unit tests
│   └── helpers/setup.js         ← test database bootstrap
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## admin panel features

the admin is basically the game master. here's what they can do:

- **before the event**: create teams (with passwords), add prompts, configure game settings (base time, min bid, slots per prompt, bid duration)
- **team management**: add/remove/activate/deactivate teams on the fly. if a team doesn't show up, just deactivate them and the system adjusts.
- **start bidding**: kick off round 1. this reveals the first prompt and starts the 60-second timer.
- **pause/resume**: if something goes wrong mid-bid (technical issues, someone has a question), admin can freeze the timer.
- **extend time**: add extra seconds to the current prompt's timer if needed.
- **skip prompt**: force-move to the next prompt if the current one's done early.
- **start round 2**: after round 1 ends, admin checks if any teams are unassigned and starts round 2 if needed.
- **submit scores**: after coding is done, admin enters judge scores for each team. system auto-calculates final score using the multiplier.
- **view leaderboard**: real-time leaderboard showing all teams, their prompts, bid times, multipliers, judge scores, and final scores.
- **reset**: blow everything away and start fresh. just in case.

---

## auth flow

keeping this simple since its a one-day offline hackathon.

1. admin creates teams ahead of time with team names and passwords
2. each team gets a slip with their team name and password
3. teams go to the bidding page, enter their creds, get a JWT
4. JWT contains `{ teamId, teamName, role: "team" }`
5. admin logs in separately with admin creds, JWT has `{ role: "admin" }`
6. socket connections also authenticate using the same JWT (sent in the handshake)
7. tokens don't need to expire for a hackathon — keep them valid for 24 hours and call it a day

what the implementation does with that:

- passwords are stored as bcrypt hashes, never in plain text
- the admin account is bootstrapped from `ADMIN_USERNAME` / `ADMIN_PASSWORD` on startup, and only
  when no account with that username exists — changing the admin password through the api survives
  a redeploy
- login is rejected for deactivated teams, so the admin toggle works from the first login
- tokens are stateless, so `logout` is a client side discard. no refresh tokens, no revocation list
- `GET /api/auth/me` returns the identity behind a token, handy for the client to restore a session

---

## environment variables

copy `.env.example` to `.env` and fill it in. `.env` is gitignored, never commit it.

| variable | purpose | default |
|----------|---------|---------|
| `DATABASE_URL` | postgres connection string | — |
| `DATABASE_URL_TEST` | database used by the test suite | — |
| `JWT_SECRET` | signing secret for the tokens | dev fallback, change it |
| `JWT_EXPIRES_IN` | token lifetime | `24h` |
| `JWT_ISSUER` | token issuer claim | `acm-bidding-platform` |
| `BCRYPT_SALT_ROUNDS` | bcrypt cost | `10` |
| `ADMIN_USERNAME` | admin account bootstrapped on startup | `admin` |
| `ADMIN_PASSWORD` | password for that admin account | `admin123` |
| `PORT` | http port | `5000` |
| `CORS_ORIGIN` | allowed origin | `*` |

---

## running locally

```bash
npm install
cp .env.example .env          # then point DATABASE_URL at your postgres
npx prisma migrate dev        # creates the tables
npm run dev
```

the admin account is created on the first boot from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

### tests

the suite runs against a real postgres test database (`DATABASE_URL_TEST`), not a mock.

```bash
docker run -d --name acm-auth-db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=acm_dev -p 5432:5432 postgres:16-alpine
docker exec acm-auth-db createdb -U postgres acm_test

npm test                      # migrates the test db, then runs node:test
```

---

## deployment plan

1. **database**: supabase free tier project. gives us hosted postgres, a table editor dashboard, and connection pooling out of the box. create the project on supabase, grab the connection string for prisma.
2. **backend**: node.js app on render. handles REST api + websocket connections. no frontend here, this repo is backend only.
3. **environment variables**: DATABASE_URL (supabase connection string), JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, PORT
4. render supports websockets natively so socket.io works without any extra config.
5. run `npx prisma migrate deploy` on render as part of the build step so the schema stays in sync.

render free tier spins down after inactivity. for a live hackathon you probably want to keep it warm or just use the starter tier ($7/mo) for the day. supabase free tier has no cold start issues so the db side is fine.

---

## what happens on the day

step by step, the whole flow:

1. admin logs in, creates teams, adds 4 prompts
2. admin adjusts config if needed (team count, base time, etc.)
3. teams log in on their laptops using the creds they got
4. admin starts round 1 — first prompt appears on the big screen
5. 60 second timer starts, teams frantically bid on their devices
6. they can see everyone else's bids updating in real time
7. timer hits 0, system picks the 3 lowest bids as winners
8. winners get their assignment notification with their multiplier
9. the admin clicks Next to open Round 2 / Prompt 2; repeat manually for all prompts
10. after each round, results stay visible until the admin clicks Next
11. admin clicks Next for each remaining prompt; prompts share the pass number; another pass is available for unassigned teams with open slots
12. all teams now have prompts — coding begins
13. each team's timer counts down from their bid time
14. time's up → judges evaluate → admin enters scores
15. system calculates final scores → leaderboard → winner announced

thats the full picture. time to build.
