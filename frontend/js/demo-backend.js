/* =========================================================================
   demo-backend.js — in-browser stand-in for the SmartHabbit API.

   Loaded before api.js in the static demo build (see scripts/build-demo.sh).
   It answers every /api/* call the frontend makes, using the same response
   shapes and game rules as the real Express + PostgreSQL backend:
     · XP by difficulty (10 / 25 / 50) with the 7-, 30- and 100-day streak
       multipliers, coins = XP / 10, level = floor(sqrt(xp / 100)) + 1
     · rewards only on the log that reaches the target, 60-second undo window
     · streak +1 when every daily habit hits its target for the day
     · badges, challenges, shop, boosts, friends, chat, notifications

   The seed (js/demo-seed.js) was recorded from the real API. All state lives
   in localStorage, so every visitor gets a private copy they can reset.
   ========================================================================= */

(function (global) {
  'use strict';

  const ORIGIN = 'https://demo.smarthabbit.local';
  const KEY = 'sh_demo_state_v1';
  const DAY = 86400000;
  const UNDO_MS = 60 * 1000; // matches the backend and the toast timer

  global.SMARTHABBIT_API_URL = ORIGIN;
  global.SMARTHABBIT_DEMO = true;

  /* ---------------- state ---------------- */
  const uid = () => (global.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16);
    }));
  const now = () => new Date().toISOString();
  const today = () => localDate(new Date());
  function localDate(d) {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }

  // Shift every timestamp in the recorded seed so "today" in the recording
  // lands on the visitor's today — streaks and history stay believable.
  function shiftSeed(seed) {
    const rec = new Date(seed.recordedAt);
    const offset = Math.round((new Date(today()) - new Date(localDate(rec))) / DAY) * DAY;
    const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = walk(v[k]); return o; }
      if (typeof v === 'string' && iso.test(v)) {
        const t = new Date(v.length === 10 ? v + 'T12:00:00Z' : v).getTime() + offset;
        return v.length === 10 ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString();
      }
      return v;
    };
    return walk(seed);
  }

  function freshState() {
    const s = shiftSeed(JSON.parse(JSON.stringify(global.__SH_SEED)));
    s.accounts = [{ id: s.me, email: 'demo@smarthabbit.app', password: 'Demo1234!' }];
    s.users.forEach((u) => {
      u.is_active = true; u.deleted_at = null; u.updated_at = u.created_at; u.is_admin = false;
      u.xp_boost_expires_at = null; u.coin_boost_expires_at = null;
      if (u.id === s.me) u.last_streak_date = localDate(new Date(Date.now() - DAY));
    });
    s.notifications.forEach((n) => { n.user_id = s.me; });
    s.mystery = [];
    s.undo = {};
    s.version = 1;
    return s;
  }

  let S;
  function load() {
    try { S = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { S = null; }
    if (!S || S.version !== 1) { S = freshState(); save(); }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* quota */ } }
  load();

  /* ---------------- helpers ---------------- */
  class HttpError extends Error {
    constructor(status, message, code, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
  }
  const user = (id) => S.users.find((u) => u.id === id);
  const levelFor = (xp) => Math.floor(Math.sqrt(xp / 100)) + 1;
  const xpForLevel = (lv) => (lv - 1) * (lv - 1) * 100;
  const shopItem = (id) => S.shop.find((i) => i.id === id) || null;
  const pub = (u) => ({ id: u.id, username: u.username, avatar_url: u.avatar_url, level: u.level, xp: u.xp });

  function meView(u) {
    const { password, ...rest } = u;
    return {
      ...rest,
      active_theme: shopItem(u.active_theme_id),
      active_avatar_frame: shopItem(u.active_avatar_frame_id)
    };
  }

  function notify(userId, title, message, type, extra = {}) {
    if (userId !== S.me && !S.accounts.some((a) => a.id === userId)) return;
    S.notifications.unshift({
      id: uid(), user_id: userId, title, message, type, is_read: false,
      related_badge_id: extra.badge || null, related_challenge_id: extra.challenge || null, created_at: now()
    });
  }

  const habitsOf = (me) => S.habits.filter((h) => h.user_id === me && h.is_active !== false);
  const logsFor = (habitId, date) => S.logs.filter((l) => l.habit_id === habitId && (!date || l.logged_date === date));
  const progressToday = (h) => logsFor(h.id, today()).reduce((a, l) => a + Number(l.value || 0), 0);
  function habitView(h) {
    const p = progressToday(h);
    return { ...h, deleted_at: null, today_progress: p, is_done_today: p >= Number(h.target_value || 1) };
  }

  /* ---------------- game rules ---------------- */
  function awardBadges(u) {
    const completions = S.logs.filter((l) => l.user_id === u.id).length;
    const challengesDone = S.userChallenges.filter((c) => c.user_id === u.id && c.status === 'completed').length;
    const stats = { streak: u.max_streak, total_xp: u.xp, completions, level: u.level, challenges_completed: challengesDone };
    const earned = [];
    for (const b of S.badges) {
      if (S.userBadges.some((x) => x.badge_id === b.id && (x.user_id || S.me) === u.id)) continue;
      if ((stats[b.criteria_type] ?? 0) >= b.criteria_value) {
        S.userBadges.push({ user_id: u.id, badge_id: b.id, earned_at: now() });
        u.xp += b.bonus_xp || 0; u.coins += b.bonus_coins || 0;
        notify(u.id, '🏆 Achievement Unlocked!', `You earned the "${b.name}" badge!`, 'badge', { badge: b.id });
        earned.push({ badgeId: b.id, badgeName: b.name, description: b.description, bonusXp: b.bonus_xp || 0, bonusCoins: b.bonus_coins || 0 });
      }
    }
    return earned;
  }

  function updateStreak(u) {
    const daily = habitsOf(u.id).filter((h) => h.goal_type === 'daily');
    const allDone = daily.length > 0 && daily.every((h) => progressToday(h) >= Number(h.target_value || 1));
    if (!allDone) return { newStreak: u.current_streak, maxStreak: u.max_streak, streakBroken: false, shieldUsed: false, pendingTodayCompletion: true };
    if (u.last_streak_date !== today()) {
      const yesterday = localDate(new Date(Date.now() - DAY));
      u.current_streak = u.last_streak_date === yesterday ? u.current_streak + 1 : 1;
      u.max_streak = Math.max(u.max_streak, u.current_streak);
      u.last_streak_date = today();
      if ([7, 14, 30, 50, 100].includes(u.current_streak))
        notify(u.id, '🔥 Streak milestone', `${u.current_streak} days in a row. Keep it going!`, 'streak');
    }
    return { userId: u.id, newStreak: u.current_streak, maxStreak: u.max_streak, streakBroken: false, shieldUsed: false, pendingTodayCompletion: false };
  }

  function bumpChallenges(u) {
    const done = [];
    for (const uc of S.userChallenges.filter((c) => c.user_id === u.id && c.status === 'joined')) {
      const c = S.challenges.find((x) => x.id === uc.challenge_id);
      if (!c) continue;
      uc.progress += 1;
      if (uc.progress >= c.target_value) {
        uc.status = 'completed'; uc.completed_at = now();
        u.xp += c.reward_xp; u.coins += c.reward_coins;
        notify(u.id, '🎯 Challenge complete', `You completed "${c.name}" and earned ${c.reward_xp} XP and ${c.reward_coins} coins!`, 'challenge', { challenge: c.id });
        done.push(c);
      }
    }
    return done;
  }

  function logHabit(me, habitId, value) {
    const u = user(me);
    const h = S.habits.find((x) => x.id === habitId && x.user_id === me);
    if (!h) throw new HttpError(404, 'Habit not found');
    const target = Number(h.target_value || 1);
    const before = progressToday(h);
    if (before >= target) throw new HttpError(400, "You've already hit today's target for this habit", 'HABIT_ALREADY_AT_TARGET');
    const after = Math.min(target, before + (Number(value) || 1));
    const crossing = after >= target;

    let xp = 0, coins = 0; const boosts = { xp: false, coins: false };
    if (crossing) {
      const base = { easy: 10, medium: 25, hard: 50 }[h.difficulty] || 10;
      const mult = u.current_streak >= 100 ? 2 : u.current_streak >= 30 ? 1.5 : u.current_streak >= 7 ? 1.25 : 1;
      xp = Math.floor(base * mult);
      if (u.xp_boost_expires_at && new Date(u.xp_boost_expires_at) > new Date()) { xp *= (u.xp_boost_mult || 2); boosts.xp = true; }
      coins = Math.floor(xp / 10);
      if (u.coin_boost_expires_at && new Date(u.coin_boost_expires_at) > new Date()) { coins *= (u.coin_boost_mult || 2); boosts.coins = true; }
    }
    const log = { id: uid(), habit_id: h.id, user_id: me, logged_date: today(), value: String(after - before), xp_earned: xp, coins_earned: coins, created_at: now() };
    S.logs.push(log);
    S.undo[me] = { logId: log.id, habitId: h.id, at: Date.now() };

    const oldLevel = u.level;
    u.xp += xp; u.coins += coins;
    const streak = updateStreak(u);
    const challengesCompleted = crossing ? bumpChallenges(u) : [];
    u.level = levelFor(u.xp);
    const badgesEarned = awardBadges(u);
    u.level = levelFor(u.xp);
    let mysteryBoxId = null;
    for (let lv = oldLevel + 1; lv <= u.level; lv++) {
      notify(me, '⬆️ Level up!', `You reached level ${lv}.`, 'level');
      if (lv % 10 === 0) { mysteryBoxId = uid(); S.mystery.push({ id: mysteryBoxId, user_id: me, level_awarded: lv, opened_at: null, created_at: now() }); }
    }
    return {
      habitCompletion: {
        userId: me, habitId: h.id, xpEarned: xp, coinsEarned: coins, newLevel: u.level,
        leveledUp: u.level > oldLevel, newStreak: u.current_streak, boostsApplied: boosts,
        todayProgress: after, targetValue: target, justCompleted: crossing, mysteryBoxId
      },
      streak, badgesEarned, challengesCompleted
    };
  }

  function undoLast(me, habitId) {
    const u = user(me);
    const last = S.undo[me];
    if (!last || last.habitId !== habitId) throw new HttpError(400, 'Nothing to undo', 'NOTHING_TO_UNDO');
    if (Date.now() - last.at > UNDO_MS) throw new HttpError(400, 'Undo window expired', 'UNDO_WINDOW_EXPIRED');
    const i = S.logs.findIndex((l) => l.id === last.logId);
    const log = S.logs[i];
    if (i >= 0) S.logs.splice(i, 1);
    u.xp = Math.max(0, u.xp - (log?.xp_earned || 0));
    u.coins = Math.max(0, u.coins - (log?.coins_earned || 0));
    u.level = levelFor(u.xp);
    delete S.undo[me];
    return { refunded: { xp: log?.xp_earned || 0, coins: log?.coins_earned || 0 }, user: { xp: u.xp, coins: u.coins, level: u.level, current_streak: u.current_streak } };
  }

  /* ---------------- friends / chat ---------------- */
  const friendRows = (me) => S.friends.filter((f) => f.status === 'accepted' && (f.user_id === me || f.friend_id === me));
  const otherOf = (f, me) => (f.user_id === me ? f.friend_id : f.user_id);
  const REPLIES = [
    'Nice, keep that streak alive 🔥', 'Haha I just logged mine too', 'Deal. Loser buys coffee ☕',
    'On it! Just finished my workout 💪', 'That badge looks great on your profile', 'See you at the leaderboard 😄'
  ];
  function scheduleReply(me, friendId) {
    const f = user(friendId);
    if (!f) return;
    setTimeout(() => {
      load();
      const msg = { id: uid(), sender_id: friendId, receiver_id: me, body: REPLIES[Math.floor(Math.random() * REPLIES.length)], is_read: false, created_at: now() };
      S.messages.push(msg); save();
      sockets.forEach((s) => s._fire('chat:message', msg));
    }, 1800 + Math.random() * 1500);
  }
  function sendMessage(me, to, body) {
    body = String(body || '').trim();
    if (!body) throw new HttpError(400, 'Message cannot be empty');
    if (!friendRows(me).some((f) => otherOf(f, me) === to)) throw new HttpError(403, 'You can only message friends');
    const msg = { id: uid(), sender_id: me, receiver_id: to, body: body.slice(0, 2000), is_read: false, created_at: now() };
    S.messages.push(msg);
    scheduleReply(me, to);
    return msg;
  }

  /* ---------------- router ---------------- */
  const routes = [];
  const on = (method, pattern, fn, open) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, fn, open });
  };
  const ok = (data, message, status = 200) => ({ status, body: { success: true, ...(message ? { message } : {}), ...(data !== undefined ? { data } : {}) } });

  // auth
  function tokens(u) {
    return { user: meView(u), accessToken: 'demo.' + u.id + '.' + Date.now(), refreshToken: 'demo-refresh.' + u.id };
  }
  on('POST', '/auth/login', ({ body }) => {
    const acc = S.accounts.find((a) => a.email.toLowerCase() === String(body.email || '').toLowerCase().trim());
    if (!acc || acc.password !== body.password) throw new HttpError(401, 'Invalid credentials');
    const u = user(acc.id); u.last_active_at = now();
    return ok(tokens(u), 'Login successful');
  }, true);
  on('POST', '/auth/register', ({ body }) => {
    const username = String(body.username || '').trim(), email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Invalid email format');
    const errors = [];
    if (pw.length < 8) errors.push('Password must be at least 8 characters long');
    if (!/[A-Z]/.test(pw)) errors.push('Password must contain at least one uppercase letter');
    if (!/[a-z]/.test(pw)) errors.push('Password must contain at least one lowercase letter');
    if (!/\d/.test(pw)) errors.push('Password must contain at least one number');
    if (errors.length) throw new HttpError(400, 'Password does not meet requirements', 'WEAK_PASSWORD', { errors });
    if (username.length < 3) throw new HttpError(400, 'Username must be at least 3 characters');
    if (S.accounts.some((a) => a.email === email) || S.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
      throw new HttpError(409, 'User with this email or username already exists');
    const u = { id: uid(), username, email, xp: 0, level: 1, coins: 100, current_streak: 0, max_streak: 0, avatar_url: null,
      created_at: now(), updated_at: now(), is_active: true, deleted_at: null, is_admin: false, streak_shields_count: 0,
      interests: [], onboarded_at: null, active_theme_id: null, active_avatar_frame_id: null, last_streak_date: null };
    S.users.push(u); S.accounts.push({ id: u.id, email, password: pw });
    // Friendly welcome: Mariam already sent a request.
    S.friends.push({ id: uid(), user_id: S.users[0].id, friend_id: u.id, status: 'pending', created_at: now() });
    notify(u.id, '👋 Welcome to SmartHabbit', 'Pick a few habits and log your first one today.', 'system');
    return ok(tokens(u), 'User registered successfully', 201);
  }, true);
  on('POST', '/auth/refresh', ({ body }) => {
    const id = String(body.refreshToken || '').split('.')[1];
    const u = user(id); if (!u) throw new HttpError(401, 'Invalid refresh token');
    const t = tokens(u); return ok({ accessToken: t.accessToken, refreshToken: t.refreshToken });
  }, true);
  on('POST', '/auth/logout', () => ok(null, 'Logged out'), true);
  on('POST', '/auth/forgot-password', () => ok(null, 'If that email exists, a reset link has been sent. (Demo: no email is actually sent.)'), true);
  on('POST', '/auth/reset-password', () => { throw new HttpError(400, 'Password reset links are disabled in the demo.'); }, true);

  // users
  on('GET', '/users/me', ({ me }) => ok({ user: meView(user(me)) }));
  on('PUT', '/users/me', ({ me, body }) => {
    const u = user(me);
    if (body.username !== undefined) {
      const n = String(body.username).trim();
      if (n.length < 3) throw new HttpError(400, 'Username must be at least 3 characters');
      if (S.users.some((x) => x.id !== me && x.username.toLowerCase() === n.toLowerCase())) throw new HttpError(409, 'Username already taken');
      u.username = n;
    }
    if (body.avatar_url !== undefined) u.avatar_url = body.avatar_url || null;
    u.updated_at = now();
    return ok({ user: meView(u) }, 'Profile updated');
  });
  on('POST', '/users/me/avatar', async ({ me, rawBody }) => {
    const file = rawBody && rawBody.get ? rawBody.get('avatar') : null;
    if (!file) throw new HttpError(400, 'No file uploaded');
    if (file.size > 2 * 1024 * 1024) throw new HttpError(413, 'File too large (max 2 MB)');
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const u = user(me); u.avatar_url = url;
    return ok({ user: meView(u) }, 'Avatar updated');
  });
  on('DELETE', '/users/me', ({ me }) => {
    S.users = S.users.filter((u) => u.id !== me); S.accounts = S.accounts.filter((a) => a.id !== me);
    S.habits = S.habits.filter((h) => h.user_id !== me);
    return ok(null, 'Account deleted');
  });
  on('GET', '/users/search', ({ me, query }) => {
    const q = (query.get('q') || '').toLowerCase().trim();
    const users = !q ? [] : S.users.filter((u) => u.id !== me && u.username.toLowerCase().includes(q)).map(pub);
    return ok({ users });
  });
  on('GET', '/users/:id/stats', ({ params }) => {
    const u = user(params.id); if (!u) throw new HttpError(404, 'User not found');
    const next = xpForLevel(u.level + 1), floor = xpForLevel(u.level);
    return ok({ stats: { id: u.id, username: u.username, email: u.email, xp: u.xp, level: u.level, coins: u.coins,
      current_streak: u.current_streak, max_streak: u.max_streak, avatar_url: u.avatar_url, created_at: u.created_at,
      total_xp: u.xp, total_habits_logged: S.logs.filter((l) => l.user_id === u.id).length,
      nextLevelXP: next, progressToNextLevel: Math.min(1, Math.max(0, (u.xp - floor) / Math.max(1, next - floor))) } });
  });

  // habits
  on('GET', '/habits', ({ me }) => ok({ habits: habitsOf(me).map(habitView) }));
  on('POST', '/habits', ({ me, body }) => {
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, 'Habit name is required');
    const h = { id: uid(), user_id: me, name, description: body.description || null, goal_type: body.goal_type || 'daily',
      difficulty: body.difficulty || 'easy', target_value: Number(body.target_value || 1).toFixed(2), target_unit: body.target_unit || null,
      is_active: true, created_at: now(), updated_at: now(), remind_at: body.remind_at || null, reminder_enabled: !!body.reminder_enabled };
    S.habits.push(h);
    return ok({ habit: habitView(h) }, 'Habit created', 201);
  });
  const ownHabit = (me, id) => { const h = S.habits.find((x) => x.id === id && x.user_id === me && x.is_active !== false); if (!h) throw new HttpError(404, 'Habit not found'); return h; };
  on('GET', '/habits/:id', ({ me, params }) => ok({ habit: habitView(ownHabit(me, params.id)) }));
  on('PUT', '/habits/:id', ({ me, params, body }) => {
    const h = ownHabit(me, params.id);
    for (const k of ['name', 'description', 'goal_type', 'difficulty', 'target_unit', 'remind_at', 'reminder_enabled']) if (body[k] !== undefined) h[k] = body[k];
    if (body.target_value !== undefined) h.target_value = Number(body.target_value || 1).toFixed(2);
    h.updated_at = now();
    return ok({ habit: habitView(h) }, 'Habit updated');
  });
  on('DELETE', '/habits/:id', ({ me, params }) => { ownHabit(me, params.id).is_active = false; return ok(null, 'Habit deleted'); });
  on('GET', '/habits/:id/history', ({ me, params }) => {
    ownHabit(me, params.id);
    const logs = logsFor(params.id).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((l) => ({ ...l, logged_date: l.logged_date + 'T00:00:00.000Z' }));
    return ok({ logs });
  });
  on('POST', '/habits/:id/log', ({ me, params, body }) => ok(logHabit(me, params.id, body.value), undefined, 201));
  on('DELETE', '/habits/:id/log/last', ({ me, params }) => ok(undoLast(me, params.id)));

  // badges
  const earnedBy = (me) => S.userBadges.filter((x) => (x.user_id || S.me) === me);
  on('GET', '/badges', () => ok({ badges: S.badges.map(({ bonus_xp, bonus_coins, ...b }) => b) }));
  on('GET', '/badges/user/earned', ({ me }) => ok({ badges: earnedBy(me).map((x) => {
    const { bonus_xp, bonus_coins, ...b } = S.badges.find((y) => y.id === x.badge_id) || {}; return { ...b, earned_at: x.earned_at };
  }).filter((b) => b.id) }));

  // challenges
  on('GET', '/challenges', () => ok({ challenges: S.challenges }));
  on('GET', '/challenges/user/active', ({ me }) => ok({ challenges: S.userChallenges.filter((c) => c.user_id === me).map((uc) => {
    const c = S.challenges.find((x) => x.id === uc.challenge_id) || {};
    return { challenge_id: uc.challenge_id, user_id: me, status: uc.status, progress: uc.progress, target_value: c.target_value,
      progress_percent: ((uc.progress / Math.max(1, c.target_value)) * 100).toFixed(2) };
  }) }));
  on('GET', '/challenges/:id/leaderboard', ({ params }) => {
    const c = S.challenges.find((x) => x.id === params.id); if (!c) throw new HttpError(404, 'Challenge not found');
    const rows = S.userChallenges.filter((x) => x.challenge_id === c.id).map((uc) => ({ ...pub(user(uc.user_id) || { username: 'someone' }), progress: uc.progress, target_value: c.target_value, status: uc.status }))
      .sort((a, b) => b.progress - a.progress).map((r, i) => ({ ...r, rank: String(i + 1) }));
    return ok({ leaderboard: rows });
  });
  on('POST', '/challenges/:id/join', ({ me, params }) => {
    if (!S.challenges.some((c) => c.id === params.id)) throw new HttpError(404, 'Challenge not found');
    if (S.userChallenges.some((x) => x.user_id === me && x.challenge_id === params.id)) throw new HttpError(400, 'Already joined this challenge');
    S.userChallenges.push({ user_id: me, challenge_id: params.id, status: 'joined', progress: 0, joined_at: now() });
    return ok(undefined, 'Challenge joined successfully', 201);
  });
  on('DELETE', '/challenges/:id/leave', ({ me, params }) => {
    S.userChallenges = S.userChallenges.filter((x) => !(x.user_id === me && x.challenge_id === params.id && x.status !== 'completed'));
    return ok(undefined, 'Left challenge successfully');
  });

  // shop
  const shopView = (i) => ({ ...i, itemType: i.item_type, metadata: i.meta_data, isAvailable: i.is_available });
  const owned = (me) => S.purchases.filter((p) => (p.user_id || S.me) === me);
  on('GET', '/shop/items', () => ok({ items: S.shop.map(shopView) }));
  on('GET', '/shop/user/inventory', ({ me }) => ok({ inventory: owned(me).map((p) => {
    const i = shopItem(p.item_id); return i && ['theme', 'avatar_item'].includes(i.item_type)
      ? { id: i.id, name: i.name, description: i.description, item_type: i.item_type, meta_data: i.meta_data, purchased_at: p.purchased_at } : null;
  }).filter(Boolean) }));
  on('POST', '/shop/purchase', ({ me, body }) => {
    const u = user(me); const i = shopItem(body.itemId || body.item_id);
    if (!i) throw new HttpError(400, 'Item not found', 'PURCHASE_FAILED');
    if (['theme', 'avatar_item', 'badge'].includes(i.item_type) && owned(me).some((p) => p.item_id === i.id)) throw new HttpError(400, 'You already own this item', 'PURCHASE_FAILED');
    if (u.coins < i.cost) throw new HttpError(402, 'Insufficient coins', 'INSUFFICIENT_COINS');
    u.coins -= i.cost;
    const m = i.meta_data || {};
    if (m.effect === 'streak_protection') u.streak_shields_count += m.uses || 1;
    if (m.effect === 'xp_boost') { u.xp_boost_expires_at = new Date(Date.now() + m.duration_hours * 3600000).toISOString(); u.xp_boost_mult = m.multiplier; }
    if (m.effect === 'coin_boost') { u.coin_boost_expires_at = new Date(Date.now() + m.duration_hours * 3600000).toISOString(); u.coin_boost_mult = m.multiplier; }
    const purchase = { id: uid(), user_id: me, item_id: i.id, cost_paid: i.cost, purchased_at: now() };
    S.purchases.push(purchase);
    notify(me, '🛍️ Purchase Complete', `You bought ${i.name} for ${i.cost} coins.`, 'shop');
    return ok({ purchase }, 'Purchase successful', 201);
  });
  on('POST', '/shop/items/unequip/:type', ({ me, params }) => {
    const u = user(me);
    if (params.type === 'theme') u.active_theme_id = null; else if (params.type === 'avatar_item') u.active_avatar_frame_id = null;
    else throw new HttpError(400, 'Invalid type');
    return ok({ user: meView(u) }, 'Unequipped');
  });
  on('POST', '/shop/items/:id/equip', ({ me, params }) => {
    const u = user(me); const i = shopItem(params.id);
    if (!i || !['theme', 'avatar_item'].includes(i.item_type)) throw new HttpError(400, 'Only themes and avatar frames can be equipped');
    if (!owned(me).some((p) => p.item_id === i.id)) throw new HttpError(400, "You don't own this item");
    if (i.item_type === 'theme') u.active_theme_id = i.id; else u.active_avatar_frame_id = i.id;
    return ok({ user: meView(u) }, 'Item equipped');
  });

  // friends
  on('GET', '/friends', ({ me }) => ok({ friends: friendRows(me).map((f) => {
    const o = user(otherOf(f, me)); return o && { id: f.id, user_id: me, friend_id: o.id, friend_user_id: o.id, username: o.username, avatar_url: o.avatar_url, level: o.level, xp: o.xp, status: f.status, created_at: f.created_at, current_streak: o.current_streak };
  }).filter(Boolean) }));
  on('GET', '/friends/requests/pending', ({ me }) => ok({ requests: S.friends.filter((f) => f.friend_id === me && f.status === 'pending').map((f) => {
    const o = user(f.user_id); return o && { id: f.id, user_id: o.id, friend_id: me, username: o.username, avatar_url: o.avatar_url, level: o.level, xp: o.xp, status: f.status, created_at: f.created_at };
  }).filter(Boolean) }));
  on('POST', '/friends/request/:id', ({ me, params }) => {
    if (params.id === me) throw new HttpError(400, "You can't add yourself");
    if (!user(params.id)) throw new HttpError(404, 'User not found');
    if (S.friends.some((f) => (f.user_id === me && f.friend_id === params.id) || (f.user_id === params.id && f.friend_id === me)))
      throw new HttpError(400, 'Friend request already exists');
    const f = { id: uid(), user_id: me, friend_id: params.id, status: 'pending', created_at: now() };
    S.friends.push(f);
    // Demo friends are friendly: they accept a few seconds later.
    setTimeout(() => {
      load(); const row = S.friends.find((x) => x.id === f.id);
      if (row && row.status === 'pending') {
        row.status = 'accepted';
        notify(me, '✅ Friend Request Accepted', `${user(params.id).username} accepted your friend request.`, 'friend');
        save();
      }
    }, 4000);
    return ok({ request: f }, 'Friend request sent', 201);
  });
  on('PUT', '/friends/:id/:action', ({ me, params }) => {
    const f = S.friends.find((x) => x.id === params.id && x.friend_id === me && x.status === 'pending');
    if (!f) throw new HttpError(404, 'Friend request not found');
    if (params.action === 'accept') f.status = 'accepted';
    else if (params.action === 'reject') S.friends = S.friends.filter((x) => x !== f);
    else throw new HttpError(400, 'Invalid action');
    return ok(undefined, params.action === 'accept' ? 'Friend request accepted' : 'Friend request rejected');
  });
  on('DELETE', '/friends/:id', ({ me, params }) => {
    S.friends = S.friends.filter((f) => !(f.id === params.id || (otherOf(f, me) === params.id && (f.user_id === me || f.friend_id === me))));
    return ok(undefined, 'Friend removed');
  });

  // leaderboards
  const board = (list, key) => list.slice().sort((a, b) => b[key] - a[key] || b.level - a.level).map((u, i) => ({ rank: String(i + 1), ...u }));
  const lbRow = (u) => ({ id: u.id, username: u.username, avatar_url: u.avatar_url, level: u.level, xp: u.xp, current_streak: u.current_streak, max_streak: u.max_streak });
  on('GET', '/leaderboards/global', () => ok({ leaderboard: board(S.users.map(lbRow), 'xp') }));
  on('GET', '/leaderboards/friends', ({ me }) => ok({ leaderboard: board([me, ...friendRows(me).map((f) => otherOf(f, me))].map(user).filter(Boolean).map(lbRow), 'xp') }));
  on('GET', '/leaderboards/weekly', () => {
    const since = localDate(new Date(Date.now() - 7 * DAY));
    const weekly = (u) => {
      const own = S.logs.filter((l) => l.user_id === u.id && l.logged_date >= since).reduce((a, l) => a + l.xp_earned, 0);
      return own || Math.round(u.xp * 0.38); // seeded friends have no logs; estimate from their level
    };
    return ok({ leaderboard: board(S.users.map((u) => ({ id: u.id, username: u.username, avatar_url: u.avatar_url, level: u.level, weekly_xp: weekly(u) })), 'weekly_xp')
      .map((r) => ({ ...r, weekly_xp: String(r.weekly_xp) })) });
  });

  // notifications
  const myNotes = (me) => S.notifications.filter((n) => n.user_id === me);
  on('GET', '/notifications', ({ me }) => ok({ notifications: myNotes(me).slice(0, 50) }));
  on('GET', '/notifications/unread/count', ({ me }) => ok({ count: myNotes(me).filter((n) => !n.is_read).length }));
  on('PUT', '/notifications/mark-all/read', ({ me }) => { const l = myNotes(me).filter((n) => !n.is_read); l.forEach((n) => { n.is_read = true; }); return ok({ count: l.length }, `${l.length} notifications marked as read`); });
  on('PUT', '/notifications/:id/read', ({ me, params }) => { const n = myNotes(me).find((x) => x.id === params.id); if (!n) throw new HttpError(404, 'Notification not found'); n.is_read = true; return ok({ notification: n }); });
  on('DELETE', '/notifications/:id', ({ me, params }) => { S.notifications = S.notifications.filter((n) => !(n.user_id === me && n.id === params.id)); return ok(undefined, 'Notification deleted'); });
  on('DELETE', '/notifications', ({ me }) => { S.notifications = S.notifications.filter((n) => n.user_id !== me); return ok(undefined, 'All notifications cleared'); });

  // chat
  on('GET', '/chat/conversations', ({ me }) => {
    const convs = friendRows(me).map((f) => {
      const o = user(otherOf(f, me)); if (!o) return null;
      const thread = S.messages.filter((m) => (m.sender_id === me && m.receiver_id === o.id) || (m.sender_id === o.id && m.receiver_id === me));
      const last = thread[thread.length - 1];
      return { friend_id: o.id, username: o.username, avatar_url: o.avatar_url, level: o.level,
        last_message: last ? last.body : null, last_message_at: last ? last.created_at : null,
        unread_count: thread.filter((m) => m.receiver_id === me && !m.is_read).length };
    }).filter(Boolean).sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
    return ok({ conversations: convs });
  });
  on('GET', '/chat/unread/count', ({ me }) => ok({ count: S.messages.filter((m) => m.receiver_id === me && !m.is_read).length }));
  on('GET', '/chat/with/:id', ({ me, params, query }) => {
    const lim = Number(query.get('limit') || 50);
    const thread = S.messages.filter((m) => (m.sender_id === me && m.receiver_id === params.id) || (m.sender_id === params.id && m.receiver_id === me));
    return ok({ messages: thread.slice(-lim) });
  });
  on('POST', '/chat/with/:id', ({ me, params, body }) => ok({ message: sendMessage(me, params.id, body.body) }, undefined, 201));
  on('PUT', '/chat/with/:id/read', ({ me, params }) => { let n = 0; S.messages.forEach((m) => { if (m.sender_id === params.id && m.receiver_id === me && !m.is_read) { m.is_read = true; n++; } }); return ok({ count: n }); });

  // mystery boxes
  on('GET', '/mystery/pending', ({ me }) => ok({ boxes: S.mystery.filter((b) => b.user_id === me && !b.opened_at) }));
  on('POST', '/mystery/:id/open', ({ me, params }) => {
    const b = S.mystery.find((x) => x.id === params.id && x.user_id === me && !x.opened_at);
    if (!b) throw new HttpError(404, 'Mystery box not found');
    b.opened_at = now();
    const u = user(me);
    const themes = S.shop.filter((i) => i.item_type === 'theme' && !owned(me).some((p) => p.item_id === i.id));
    let reward;
    if (themes.length && Math.random() < 0.5) {
      const t = themes[Math.floor(Math.random() * themes.length)];
      S.purchases.push({ id: uid(), user_id: me, item_id: t.id, cost_paid: 0, purchased_at: now() });
      reward = { kind: 'theme', value: t };
    } else { const c = 100 + 25 * Math.floor(Math.random() * 9); u.coins += c; reward = { kind: 'coins', value: { coins: c } }; }
    return ok({ reward });
  });

  // onboarding
  on('GET', '/onboarding/status', ({ me }) => { const u = user(me); return ok({ onboarded: !!u.onboarded_at, interests: u.interests || [] }); });
  on('GET', '/onboarding/interests', () => ok({ interests: S.interests }));
  on('GET', '/onboarding/recommend', ({ query }) => {
    const want = (query.get('interests') || '').split(',').filter(Boolean);
    return ok({ templates: S.templates.filter((t) => !want.length || want.includes(t.interest)) });
  });
  on('POST', '/onboarding/complete', ({ me, body }) => {
    const u = user(me);
    u.interests = (body.interests || []).slice(0, 6); u.onboarded_at = now();
    const created = [];
    for (const id of body.template_ids || []) {
      const t = S.templates.find((x) => x.id === id); if (!t) continue;
      const h = { id: uid(), user_id: me, name: t.name, description: t.description, goal_type: t.goal_type, difficulty: t.difficulty,
        target_value: Number(t.target_value).toFixed(2), target_unit: null, is_active: true, created_at: now(), updated_at: now(), remind_at: null, reminder_enabled: false };
      S.habits.push(h); created.push(h);
    }
    return ok({ user: meView(u), habits: created }, 'Onboarding complete');
  });

  // admin — the demo account is a regular user
  on('GET', '/admin/.*', () => { throw new HttpError(403, 'Admin tools are not available in the demo'); });

  /* ---------------- fetch interception ---------------- */
  const realFetch = global.fetch.bind(global);
  const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handle(url, init) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '');
    const method = (init.method || 'GET').toUpperCase();
    await wait(90 + Math.random() * 140); // feel like a network call
    load(); // another tab may have changed the state
    const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    const tokenUser = auth.startsWith('Bearer demo.') ? auth.split('.')[1] : null;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(path); if (!m) continue;
      const me = tokenUser && user(tokenUser) ? tokenUser : null;
      if (!r.open && !me) return json(401, { success: false, message: 'Authentication required' });
      let body = {}; let rawBody = null;
      if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } } else if (init.body) rawBody = init.body;
      const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const out = await r.fn({ me, params, body, rawBody, query: u.searchParams });
        save();
        return json(out.status, out.body);
      } catch (e) {
        if (!(e instanceof HttpError)) { console.error('[demo]', e); return json(500, { success: false, message: 'Something went wrong' }); }
        return json(e.status, { success: false, message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });
      }
    }
    return json(404, { success: false, message: 'Not found in demo: ' + method + ' ' + path });
  }

  global.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.startsWith(ORIGIN)) return handle(url, init);
    return realFetch(input, init);
  };

  /* ---------------- socket.io stand-in (chat) ---------------- */
  const sockets = [];
  function FakeSocket(token) {
    this.handlers = {}; this.me = String(token || '').split('.')[1];
    sockets.push(this);
    setTimeout(() => this._fire('connect'), 300);
  }
  FakeSocket.prototype.on = function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; };
  FakeSocket.prototype._fire = function (ev, data) { (this.handlers[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); };
  FakeSocket.prototype.emit = function (ev, data, ack) {
    load();
    if (ev === 'chat:send') {
      try { const msg = sendMessage(this.me, data.to, data.body); save(); if (ack) ack({ ok: true, message: msg }); }
      catch (e) { if (ack) ack({ ok: false, error: e.message }); }
    } else if (ev === 'chat:read') {
      S.messages.forEach((m) => { if (m.sender_id === data.from && m.receiver_id === this.me) m.is_read = true; }); save();
    }
    return this;
  };
  FakeSocket.prototype.disconnect = function () { this._fire('disconnect'); };
  Object.defineProperty(global, 'io', {
    configurable: true,
    get() { return (url, opts) => new FakeSocket(opts && opts.auth && opts.auth.token); },
    set() { /* ignore the CDN client if it loads anyway */ }
  });

  /* ---------------- demo ribbon ---------------- */
  global.SMARTHABBIT_DEMO_RESET = function () {
    localStorage.removeItem(KEY);
    ['sh_access_token', 'sh_refresh_token', 'sh_user'].forEach((k) => localStorage.removeItem(k));
    location.href = 'login.html';
  };
  function ribbon() {
    const bar = document.createElement('div');
    bar.className = 'demo-ribbon';
    bar.innerHTML = '<span><strong>Live demo</strong> · runs entirely in your browser, nothing leaves this device</span>' +
      '<button type="button">Reset demo</button>';
    bar.querySelector('button').addEventListener('click', () => global.SMARTHABBIT_DEMO_RESET());
    const css = document.createElement('style');
    css.textContent = '.demo-ribbon{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;display:flex;gap:12px;align-items:center;' +
      'padding:8px 10px 8px 16px;border-radius:999px;background:rgba(17,24,39,.92);color:#e5e7eb;font:500 12.5px/1.2 system-ui,sans-serif;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.25);max-width:calc(100vw - 24px)}.demo-ribbon strong{color:#fff}' +
      '.demo-ribbon button{border:0;border-radius:999px;padding:6px 12px;background:#fff;color:#111827;font:600 12px system-ui,sans-serif;cursor:pointer}' +
      '@media(max-width:560px){.demo-ribbon span{font-size:11.5px}}';
    document.head.appendChild(css);
    document.body.appendChild(bar);
    // Pre-fill the demo account on the sign-in page.
    if (/login\.html$/.test(location.pathname)) {
      const e = document.querySelector('input[type=email], #email'); const p = document.querySelector('input[type=password], #password');
      if (e && !e.value) e.value = 'demo@smarthabbit.app';
      if (p && !p.value) p.value = 'Demo1234!';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ribbon); else ribbon();
})(window);
