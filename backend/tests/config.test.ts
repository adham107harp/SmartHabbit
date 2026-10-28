// The config module reads process.env when it is first imported, so each
// case loads a fresh copy of it with jest.isolateModules.

const ORIGINAL_ENV = { ...process.env };

function loadConfig() {
  let mod: typeof import('../src/config') | undefined;
  jest.isolateModules(() => {
    mod = require('../src/config');
  });
  return mod!.config;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('JWT secret', () => {
  it('refuses to start in production without JWT_SECRET', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = '';
    expect(loadConfig).toThrow(/JWT_SECRET must be set/);
  });

  it('uses JWT_SECRET in production when it is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-real-secret';
    expect(loadConfig().jwt.secret).toBe('a-real-secret');
  });

  it('falls back to the development secret outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = '';
    expect(loadConfig().jwt.secret).toBe('change-me-in-production');
  });
});
