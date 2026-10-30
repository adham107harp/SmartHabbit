# Production backlog

Updated each automated run. Tests: Postgres 16 `smarthabbit_test`, run under `TZ=UTC` and `TZ=Africa/Cairo`.

## Done
- Run 1: case-insensitive email handling (admin-allowlist bypass via email casing), unique `LOWER(email)` index (migration 021, skips if legacy dupes exist).
- Run 1: refresh tokens rejected as access tokens (HTTP + socket.io); `/auth/refresh` rejects deleted users; JWT pinned to HS256.
- Run 1: `GET /users/:id/stats` now requires auth and is owner-only (leaked email/coins).
- Run 1: GitHub Actions CI (tsc + jest, Postgres 16 service, UTC + Africa/Cairo matrix).

## Next (ranked)
1. **Race: habit log double-awards XP/coins/mystery boxes** (GamificationEngine.processHabitCompletion, StreakService): `SELECT users ... FOR UPDATE` first, relative `xp = xp + $1`, add parallel-request test.
2. **Challenge reward double payout** (ChallengeService): guard completion UPDATE with `status='joined'` and rowcount; recompute level.
3. **Migration safety** (database.ts runMigrations): advisory lock + per-file transaction incl. tracking INSERT; numeric sort.
4. **Docker/compose/nginx**: remove hardcoded JWT/DB secrets (`${VAR:?}`), drop published backend port, restart policy, `init: true`, nginx security headers, drop `null` CORS origin.
5. **`app.set('trust proxy', 1)`** (env-configurable) so rate limiter keys per client behind nginx.
6. **Fail-closed config**: require JWT_SECRET unless NODE_ENV is development/test; min length; drop hardcoded default admin email.
7. **socket.io**: per-socket rate limit, friend check on `chat:typing`/`chat:read`, UUID validation, `maxHttpBufferSize`, drop `?token=` query auth, generic error acks.
8. **Input validation**: `value` > 0 bound and `target_value` caps on habits, avatar_url scheme/length, username pattern on update, UUID path params, generic 500 messages in errorHandler, pagination clamp helper (negative LIMIT -> 500 on notifications).
9. **Graceful shutdown** (timeout, double-signal guard, unhandledRejection), `db.transaction` rollback guard.
10. **Test coverage**: shop, challenges, social, admin, mystery, leaderboards, onboarding, punishmentJob, runMigrations.
11. Refresh-token rotation/revocation; bcrypt cost 12; login limiter keyed by IP+email; ShopService cosmetic ownership check and no-op badge item.
12. API docs (OpenAPI), README refresh, frontend polish.

## Risks / notes
- Admin bootstrap still grants `is_admin` to whoever first registers an allowlisted email (emails unverified). Set `ADMIN_EMAILS` in production and register that account first, or move to DB-only admin grants.
- Migration 021 only emits a NOTICE (and is still recorded as applied) if case-variant duplicate emails exist; operator must dedupe and create `users_email_lower_key` manually.
- `/users/:id/stats` is now owner-only; frontend only calls it for the current user (verified in `frontend/js/profile.js`).
