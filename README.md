# acm-bidding-platform-backend

backend + admin panel for "bid and code" — a hackathon format where teams bid on time commitments before coding.

---

## how bidding works

Each prompt is one round: Round 1 opens Prompt 1, Round 2 opens Prompt 2, and so
on in display order. The order is captured when bidding starts. The admin starts
the first round and clicks **Next** to open each subsequent prompt.

Each prompt has its own server-owned countdown. At zero, bidding closes and
winners are assigned, but the prompt, bids and results stay visible. The server
never opens another prompt on its own. **End Current Round** also closes a round
without opening the next. An admin can click Next early to close and award the
current round before opening the next one.

Teams bid their coding time in minutes (defaults: 30–120). The lowest unique bids
win the configured slots, and a team can receive only one assignment. Each bid
and assignment belongs to that prompt's round. Admin history tabs show only that
round's bids, including history written by the previous pass-based implementation.
Existing records and earned scores are preserved.

## scoring

Every prompt round uses the same curve:

```text
multiplier = exp(1 - bidMinutes / baseTime)
finalScore = judgeScore * multiplier
```

There is no later-round penalty. With a 120-minute base, a 45-minute bid receives
a 1.868 multiplier whether it wins Round 1 or Round 4. Existing earned multipliers
and scores remain stored as awarded.

## database timeouts and route verification

Run `npm run db:check` to check the configured database connection and timer
schema without changing data. `/api/health/ready` reports database readiness;
`/api/health` remains a liveness endpoint. Startup retries failed initialization.

`npm run test:routes` exercises all 42 registered HTTP routes, including auth,
validation and simulated database outages, without needing a TCP port. See
[route verification and timeout repairs](docs/route-verification.md) for exact
coverage, runtime limits and the live PostgreSQL verification boundary.

## synchronized bidding countdown

The backend starts a per-prompt countdown when bidding begins. Admin, team and
arena screens share its remaining time, pause/resume/extensions and updates.
The timer survives backend restarts through `GameConfig.biddingState`.

Apply migrations with `npm run prisma:deploy`, then generate the client with
`npm run prisma:generate` before starting this version. Run one backend instance.
See [bidding timer integration and deployment](docs/client-clock-sync.md) for the
state contract, recovery behavior and test commands.

## manual round flow

```text
Start Round 1 → Prompt 1 timer → timer ends → Round 1 results stay visible
Admin clicks Next → Round 2 / Prompt 2 timer → timer ends → Round 2 results stay visible
Admin clicks Next → Round 3 / Prompt 3 timer → ...
```

Pausing and extending affect only the current timer. A completed round cannot be
replayed or skipped through the Start action. Next works while bidding is active,
paused, or closed, and one click advances by one prompt. The last round has no
next prompt. Reset bidding before adding or reordering round prompts.

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
- `teamId` is `@unique` on Assignment — each team gets at most one prompt assignment.
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

POST   /api/admin/round/start          → open the next prompt round (Round N = Prompt N)
POST   /api/admin/round/pause          → pause current timer
POST   /api/admin/round/resume         → resume timer
POST   /api/admin/round/extend         → add time { extraSeconds }
POST   /api/admin/round/next-prompt    → manually open the next prompt round
POST   /api/admin/round/end            → force end current round

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
- **next round**: after a round closes, click Next to open the next prompt; all rounds share the same multiplier curve.
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
11. admin clicks Next for each remaining prompt; each prompt has its own round and the same multiplier curve
12. all teams now have prompts — coding begins
13. each team's timer counts down from their bid time
14. time's up → judges evaluate → admin enters scores
15. system calculates final scores → leaderboard → winner announced

thats the full picture. time to build.
