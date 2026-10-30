import request from 'supertest';
import { app, cleanDb, ensureMigrated, disconnect } from './_helpers/api';
import { db } from '../src/config/database';

beforeAll(async () => { await ensureMigrated(); });
beforeEach(async () => { await cleanDb(); });
afterAll(async () => { await disconnect(); });

describe('POST /api/auth/register', () => {
  it('creates a new user + returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'newuser', email: 'new@test.local', password: 'Smoke123!' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.username).toBe('newuser');
    expect(res.body.data.user).not.toHaveProperty('password_hash');
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(typeof res.body.data.refreshToken).toBe('string');
  });

  it('rejects duplicate email/username with 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'dup', email: 'dup@test.local', password: 'Smoke123!' });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'dup', email: 'dup@test.local', password: 'Smoke123!' });

    expect(res.status).toBe(409);
  });

  it('rejects weak passwords with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'weakpw', email: 'weak@test.local', password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'login_user', email: 'login@test.local', password: 'Smoke123!' });
  });

  it('200 on correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.local', password: 'Smoke123!' });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
  });

  it('401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@test.local', password: 'Wrong-Pw1!' });

    expect(res.status).toBe(401);
  });

  it('401 on unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@test.local', password: 'Smoke123!' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('returns a fresh token pair given a valid refresh token', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'refresher', email: 'r@test.local', password: 'Smoke123!' });
    const refreshToken: string = reg.body.data.refreshToken;

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(typeof res.body.data.refreshToken).toBe('string');
  });

  it('400 if refreshToken is missing', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('auth hardening', () => {
  it('treats emails case-insensitively (no duplicate via casing)', async () => {
    await request(app).post('/api/auth/register')
      .send({ username: 'casea', email: 'Case@Test.local', password: 'Smoke123!' });
    const dup = await request(app).post('/api/auth/register')
      .send({ username: 'caseb', email: 'case@test.local', password: 'Smoke123!' });
    expect(dup.status).toBe(409);
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'CASE@test.local', password: 'Smoke123!' });
    expect(login.status).toBe(200);
  });

  it('does not accept a refresh token as an access token', async () => {
    const reg = await request(app).post('/api/auth/register')
      .send({ username: 'refr', email: 'refr@test.local', password: 'Smoke123!' });
    const { refreshToken, accessToken } = reg.body.data;
    const bad = await request(app).get('/api/users/search?q=x').set('Authorization', `Bearer ${refreshToken}`);
    expect(bad.status).toBe(401);
    const ok = await request(app).get('/api/users/search?q=xx').set('Authorization', `Bearer ${accessToken}`);
    expect(ok.status).not.toBe(401);
  });

  it('refuses to refresh tokens for deleted accounts', async () => {
    const reg = await request(app).post('/api/auth/register')
      .send({ username: 'gone', email: 'gone@test.local', password: 'Smoke123!' });
    await db.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [reg.body.data.user.id]);
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: reg.body.data.refreshToken });
    expect(res.status).toBe(401);
  });

  it('restricts /users/:id/stats to the owner and requires auth', async () => {
    const a = await request(app).post('/api/auth/register')
      .send({ username: 'statsa', email: 'sa@test.local', password: 'Smoke123!' });
    const b = await request(app).post('/api/auth/register')
      .send({ username: 'statsb', email: 'sb@test.local', password: 'Smoke123!' });
    const aid = a.body.data.user.id;
    expect((await request(app).get(`/api/users/${aid}/stats`)).status).toBe(401);
    expect((await request(app).get(`/api/users/${aid}/stats`)
      .set('Authorization', `Bearer ${b.body.data.accessToken}`)).status).toBe(403);
    expect((await request(app).get(`/api/users/${aid}/stats`)
      .set('Authorization', `Bearer ${a.body.data.accessToken}`)).status).toBe(200);
  });
});
