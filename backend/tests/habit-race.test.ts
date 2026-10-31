import request from 'supertest';
import { app, cleanDb, ensureMigrated, disconnect, makeUser, authHeader } from './_helpers/api';
import { db } from '../src/config/database';

beforeAll(async () => { await ensureMigrated(); });
beforeEach(async () => { await cleanDb(); });
afterAll(async () => { await disconnect(); });

async function setup(username: string) {
  const u = await makeUser({ username, email: `${username}@example.com` });
  const h = await request(app)
    .post('/api/habits')
    .set(authHeader(u))
    .send({ name: 'Race', goal_type: 'daily', difficulty: 'easy', target_value: 1 });
  return { u, id: h.body.data.habit.id as string };
}

describe('concurrent habit logs', () => {
  it('pays out exactly as much as a single sequential log (no double award)', async () => {
    // Control: one sequential log (includes any first-log badge bonus).
    const control = await setup('control');
    const c = await request(app).post(`/api/habits/${control.id}/log`).set(authHeader(control.u)).send({ value: 1 });
    expect(c.status).toBe(200);
    const expected = (await db.query('SELECT xp, coins FROM users WHERE id=$1', [control.u.id]))[0];

    const { u, id } = await setup('racer');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post(`/api/habits/${id}/log`).set(authHeader(u)).send({ value: 1 })
      )
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);

    const after = (await db.query('SELECT xp, coins FROM users WHERE id=$1', [u.id]))[0];
    expect(Number(after.xp)).toBe(Number(expected.xp));
    expect(Number(after.coins)).toBe(Number(expected.coins));

    const logs = await db.query('SELECT COUNT(*)::int AS n FROM habit_logs WHERE habit_id=$1', [id]);
    expect(logs[0].n).toBe(1);
  });
});
