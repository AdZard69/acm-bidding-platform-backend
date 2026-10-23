# acm-bidding-platform-backend

backend + admin panel for "bid and code" — a hackathon format where teams bid on time commitments before coding.

---

## what is this

we're running a hackathon called **Bid and Code**. up to 10 teams show up in person, and instead of just handing out problem statements, we make them bid for it.

there are 4 prompts (problem statements). each prompt is shown on a big screen for 1 minute. during that minute, all teams place their bids — they're bidding how many minutes they'll take to solve that prompt. lower bid = less time to code but a higher score multiplier later.

its an open auction. everyone can see everyone's bids in real time on screen. no duplicate bids allowed — if someone already bid 60 mins, you can't bid 60.

after the minute is up, the 3 lowest bidders win that prompt and get pulled out of bidding. then the next prompt shows up and the remaining teams bid again. this goes on for all 4 prompts.

after round 1, any team that didn't land a prompt (either they lost every bid or just didn't bid) gets a second shot. round 2 goes through the same prompts again but only for ones that still have open slots. same 1 minute per prompt. the catch — round 2 bidders get a worse multiplier than round 1 winners. you snooze, you kinda lose.

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

say team A bids 50 mins in round 1 (multiplier 1.792) and gets a judge score of 70.
final score = 70 × 1.792 = **125.44**

team B plays safe, bids 110 mins in round 1 (multiplier 1.087), scores 90 from judges.
final score = 90 × 1.087 = **97.83**

team A wins even though their code had a few rough edges — but they also delivered in under half the total available time. risk = reward.

what if someone overcommits? team C bids 30 mins (multiplier 2.117) but panics and delivers an incomplete project, scoring 45 from judges:
final score = 45 × 2.117 = **95.27**

team C loses to both Team A and Team B. the formula rewards speed, but not at the cost of total failure.

now if someone lands in round 2 and bids 30 mins (multiplier 1.690), scores 75:
final score = 75 × 1.690 = **126.75**

they can still compete, but the reduced k factor makes sure round 2 winners don't get an outsized advantage.

---

## how the bidding flow works

### round 1 (4 minutes total)

```
prompt 1 shown → 60 sec timer → all teams bid → 3 lowest win → removed from pool
prompt 2 shown → 60 sec timer → remaining teams bid → 3 lowest win → removed
prompt 3 shown → 60 sec timer → remaining teams bid → 3 lowest win → removed
prompt 4 shown → 60 sec timer → remaining teams bid → 3 lowest win → removed
```

after each prompt's timer ends, the 3 teams with the lowest bids get assigned that prompt. they're done bidding. the rest move on.

with 10 teams and 4 prompts (3 slots each = 12 total slots), everyone should have a prompt by end of round 1. but things happen — teams might not bid, or fewer teams might show up, so round 2 exists as a safety net.

### round 2 (only if needed)

same flow but only for:
- teams that haven't been assigned a prompt yet
- prompts that still have open slots (fewer than 3 teams assigned)

round 2 uses `k = 0.7` instead of `k = 1.0` for the multiplier. you still get rewarded for low bids, just not as much.

### edge cases

- **team doesn't bid during a prompt's window**: treated as "didn't participate" for that prompt. no penalty other than not winning that slot.
- **only 1-2 teams left for last prompt**: they get it automatically. if only 1 team is left and doesn't bid, they get assigned the remaining prompt at base time (multiplier = 1.0).
- **fewer than 10 teams show up**: admin adjusts team count before starting. the math still works, you just might have fewer than 3 teams per prompt.

---

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

POST   /api/admin/round/start          → start round 1 (or round 2)
POST   /api/admin/round/pause          → pause current timer
POST   /api/admin/round/resume         → resume timer
POST   /api/admin/round/extend         → add time { extraSeconds }
POST   /api/admin/round/next-prompt    → force skip to next prompt
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
9. next prompt appears, repeat for all 4
10. after round 1, admin checks if any teams are left without a prompt
11. if yes, admin starts round 2 (same flow, reduced multiplier)
12. all teams now have prompts — coding begins
13. each team's timer counts down from their bid time
14. time's up → judges evaluate → admin enters scores
15. system calculates final scores → leaderboard → winner announced

thats the full picture. time to build.
