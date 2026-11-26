# SmartHabbit

A gamified habit-tracking web app. Build daily habits, earn XP, level up, unlock badges, climb leaderboards, and spend coins in a reward shop.

This is a university project. The whole thing — backend and frontend — runs locally with a PostgreSQL database.

**[Try the live demo →](https://adham107harp.github.io/smarthabbit/)** — sign in with the pre-filled demo account, or register your own.
The demo is the real frontend running against an in-browser copy of the API (`frontend/js/demo-backend.js`) that follows the same rules (XP, streaks, badges, challenges, shop, chat). Data stays in your browser; "Reset demo" starts over. Build it with `scripts/build-demo.sh`.

## What's inside

| Layer | Tech |
|---|---|
| **Frontend** | Plain HTML + CSS + JavaScript |
| **Backend** | Node.js + Express + TypeScript + socket.io  |
| **Database** | PostgreSQL 16 |
| **Auth** | JWT (access + refresh tokens) + bcrypt |
| **Tests** | jest + supertest (integration tests against a scratch Postgres DB) |

## Features

- Sign up, log in, log out (JWT access + refresh tokens)
- Create habits with difficulty (easy / medium / hard) and goal type (daily / weekly)
- Log habit completions — earn XP and coins, increase your streak
- **60-second "Undo" window** on every log (mis-click? click Undo in the toast)
- **Duplicate-log protection** — re-logging the same habit shows a friendly message instead of a silent overwrite
- 50 badges that unlock automatically on milestones (streaks, completions, total XP, level, challenges)
- 19 challenges with XP + coin rewards and per-challenge leaderboards
- 45 shop items (themes, avatar frames, badges, streak shields, XP and coin boosts) — **all actually work**:
  - **Themes** (10 palettes) buy in the shop, equip from Settings or Shop, re-skin the whole UI
  - **Avatar frames** wrap your photo in a coloured ring on every screen
  - **Streak shields** auto-spend when you miss a day to save your streak
  - **XP and coin boosts** multiply rewards for a limited time (4 to 24 hours)
- **Avatar**: upload your own image (PNG/JPG/WebP up to 2 MB), or pick one of 8 free preset avatars, or buy a fancy frame
- Friend system with friend requests + friends-only leaderboard
- Global, weekly, and friends-only leaderboards
- In-app notifications (level-ups, badge unlocks, challenge completions, purchases, shield used)
- Editable profile + per-habit history page
- Real-time 1:1 chat between friends (socket.io, with REST fallback)
- Onboarding: pick interests, get recommended starter habits
- Mystery box reward every 10 levels
- Admin panel (users, badges, challenges, shop items, broadcasts)

## Folder layout

```
.
├── backend/            ← Node.js API
│   ├── src/
│   │   ├── routes/         (auth, users, habits, badges, challenges, shop, friends, leaderboards,
│   │   │                    notifications, chat, mystery, onboarding, admin)
│   │   ├── services/       (gamification, streak, badge, challenge, shop, social, chat, notification logic)
│   │   ├── jobs/           (scheduled streak-penalty job)
│   │   ├── middleware/     (JWT auth, input validation, error handler)
│   │   ├── config/         (env loader + PostgreSQL pool + migration runner)
│   │   ├── utils/          (bcrypt, JWT, validators)
│   │   └── index.ts        (Express bootstrap)
│   ├── migrations/         (21 SQL files — auto-run on boot)
│   ├── scripts/            (seed.ts: shop + challenges, seed_badges_v3.ts: 50 badges)
│   ├── tests/              (jest + supertest integration tests)
│   └── .env                (copy from .env.example)
│
├── frontend/           ← Static site (open with Live Server or any static server)
│   ├── *.html              (20 pages)
│   ├── css/                (base.css + one stylesheet per page)
│   └── js/                 (api.js + auth-guard.js + ui.js + one script per page,
│                            demo-backend.js for the browser-only live demo)
│
├── documentation/      ← Specification, architecture, DB schema, production backlog, technical PDF
├── scripts/            ← build-demo.sh (static live demo)
├── diagrams/           ← ER diagram + mapping diagram (PNG)
└── DEPLOY.md           ← Docker / deployment notes
```

## Run it

### Quick start (one command)

After the database is set up (below), run:

- **Linux / macOS:** `./run-project.sh`
- **Windows:** double-click `run-project.bat`

Either script installs backend deps on first run, starts both servers, waits for the backend to be ready, then opens your browser at the landing page.

### Manual setup

#### 1. Database (one-time setup)

```bash
sudo -u postgres psql -c "CREATE USER smarthabbit WITH PASSWORD 'smarthabbit';"
sudo -u postgres psql -c "CREATE DATABASE smarthabbit_dev OWNER smarthabbit;"
```

#### 2. Backend

```bash
cd backend
cp .env.example .env       # then edit DB_PASSWORD, JWT_SECRET if you want
npm install
npm run dev                # migrations auto-run on first boot
npm run seed               # in a second terminal, load shop items + challenges
npm run seed:badges        # load the full 50-badge catalog
npm test                   # run the jest integration suite (see "Testing")
```

The API listens on **http://localhost:3000**. All endpoints live under `/api/*` — e.g. `POST /api/auth/login`, `GET /api/habits`, `GET /api/leaderboards/global`. Health check: `GET /health` (now actually pings the database, returns 503 if it's down). Uploaded avatars are served at `/uploads/avatars/...`.

#### Security & hardening (v4)

- `/api/auth/login` and `/api/auth/register` are rate-limited to **5 attempts / 15 min per IP** (successful logins don't burn the quota).
- JSON body limit is **1 MB** (down from 10 MB).
- Avatar uploads are checked by **magic bytes** server-side — a `.exe` renamed to `.jpg` is rejected even if the client sends `Content-Type: image/jpeg`.
- CORS uses a strict allowlist from the `CORS_ORIGIN` env var for both HTTP and socket.io (no more "allow everything in dev").
- Responses are gzipped via `compression`.
- The Docker image runs as an unprivileged `nodejs` user.

#### Testing

Tests use a dedicated `smarthabbit_test` database so they never wipe dev data:

```bash
# one-time setup (needs sudo)
sudo -u postgres psql -c "ALTER USER smarthabbit CREATEDB;" \
  -c "CREATE DATABASE smarthabbit_test OWNER smarthabbit;"

# then, from backend/
npm test
```

#### 3. Frontend

Open `frontend/` with **VSCode Live Server**, or run any static server:

```bash
cd frontend
npx http-server -p 5500
```

Visit **http://localhost:5500/index.html** in your browser.

## API quick reference

All authenticated requests require `Authorization: Bearer <accessToken>`.

| Group | Endpoints |
|---|---|
| `/api/auth` | `POST /register`, `POST /login`, `POST /refresh` |
| `/api/users` | `GET /me`, `PUT /me`, `POST /me/avatar` (multipart), `DELETE /me`, `GET /search?q=`, `GET /:id/stats` |
| `/api/habits` | `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, `POST /:id/log`, `DELETE /:id/log/last` (undo), `GET /:id/history` |
| `/api/badges` | `GET /`, `GET /user/earned`, `GET /user/next` |
| `/api/challenges` | `GET /`, `POST /:id/join`, `GET /user/active`, `GET /:id/leaderboard`, `DELETE /:id/leave` |
| `/api/shop` | `GET /items`, `POST /purchase`, `GET /user/inventory`, `GET /user/purchases`, `POST /items/:id/equip`, `POST /items/unequip/:type` |
| `/api/friends` | `GET /`, `GET /requests/pending`, `POST /request/:id`, `PUT /:id/accept`, `PUT /:id/decline`, `DELETE /:id`, `POST /:id/block` |
| `/api/leaderboards` | `GET /global`, `GET /friends`, `GET /weekly` |
| `/api/notifications` | `GET /`, `GET /unread/count`, `PUT /:id/read`, `PUT /mark-all/read`, `DELETE /:id`, `DELETE /` |
| `/api/chat` | `GET /conversations`, `GET /with/:friendId`, `POST /with/:friendId`, `PUT /with/:friendId/read`, `GET /unread/count` |
| `/api/mystery` | `GET /pending`, `POST /:id/open` |
| `/api/onboarding` | `GET /interests`, `GET /recommend?interests=`, `GET /status`, `POST /complete` |
| `/api/admin` | stats, users, badges, challenges, shop items, broadcast (admins only) |

## How XP, coins, and streaks work

| Difficulty | Base XP | Coins (XP/10) |
|---|---|---|
| Easy | 10 | 1 |
| Medium | 25 | 2 |
| Hard | 50 | 5 |

XP and coins are paid once per day per habit, on the log that reaches the habit's target. A streak bonus multiplier kicks in once you sustain a streak: ×1.25 at 7 days, ×1.5 at 30 days, ×2.0 at 100 days. Your level is `floor(sqrt(xp / 100)) + 1`.

## License

MIT
