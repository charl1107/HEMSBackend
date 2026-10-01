import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  DEV_JWT_SECRET_FALLBACK,
  LEGACY_PLACEHOLDER_JWT_SECRET,
  resolveJwtSecret,
} from './jwt-secret.js';

function configWith(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

describe('resolveJwtSecret', () => {
  it('throws in production when JWT_SECRET is missing', () => {
    expect(() =>
      resolveJwtSecret(configWith({ NODE_ENV: 'production' })),
    ).toThrow(/JWT_SECRET/);
  });

  it('throws in production when JWT_SECRET is empty or whitespace', () => {
    expect(() =>
      resolveJwtSecret(
        configWith({ NODE_ENV: 'production', JWT_SECRET: '   ' }),
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it('throws in production when JWT_SECRET is the dev sentinel', () => {
    expect(() =>
      resolveJwtSecret(
        configWith({
          NODE_ENV: 'production',
          JWT_SECRET: DEV_JWT_SECRET_FALLBACK,
        }),
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it('rejects the dev fallback outside production', () => {
    expect(() =>
      resolveJwtSecret(configWith({ JWT_SECRET: DEV_JWT_SECRET_FALLBACK })),
    ).toThrow(/JWT_SECRET/);
    expect(() =>
      resolveJwtSecret(
        configWith({ NODE_ENV: 'development', JWT_SECRET: DEV_JWT_SECRET_FALLBACK }),
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it('rejects the legacy placeholder secret in every environment', () => {
    expect(() =>
      resolveJwtSecret(
        configWith({ JWT_SECRET: LEGACY_PLACEHOLDER_JWT_SECRET }),
      ),
    ).toThrow(/JWT_SECRET/);
    expect(() =>
      resolveJwtSecret(
        configWith({
          NODE_ENV: 'production',
          JWT_SECRET: LEGACY_PLACEHOLDER_JWT_SECRET,
        }),
      ),
    ).toThrow(/JWT_SECRET/);
  });

  it('returns the configured secret in production', () => {
    expect(
      resolveJwtSecret(
        configWith({ NODE_ENV: 'production', JWT_SECRET: 'real-secret' }),
      ),
    ).toBe('real-secret');
  });

  it('throws outside production when JWT_SECRET is unset', () => {
    expect(() => resolveJwtSecret(configWith({}))).toThrow(/JWT_SECRET/);
    expect(() =>
      resolveJwtSecret(configWith({ NODE_ENV: 'development' })),
    ).toThrow(/JWT_SECRET/);
  });

  it('uses the configured secret outside production', () => {
    expect(resolveJwtSecret(configWith({ JWT_SECRET: 'local-secret' }))).toBe(
      'local-secret',
    );
  });
});

describe('bootstrap rejects production without JWT_SECRET', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    // Empty string (not delete): ConfigModule loads .env and would restore a
    // real secret; dotenv does not overwrite keys already present on process.env.
    process.env.JWT_SECRET = '';
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
    if (prevJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = prevJwtSecret;
    }
  });

  // Loaded in beforeAll: pulling the entire app graph out of module cache is
  // cold I/O, not the behaviour under test. Charging it to the it() timeout is
  // what made this spec fail (30s exceeded) whenever the suite ran under load.
  // Secret resolution happens in JwtModule's async factory at compile(), i.e.
  // inside the test, so loading here (before NODE_ENV is forced) is safe.
  // The explicit hook budget matters: hooks default to 10s, and a cold import
  // of the whole graph regularly takes longer than that on this machine.
  let Test: (typeof import('@nestjs/testing'))['Test'];
  let AppModule: (typeof import('../app.module.js'))['AppModule'];

  beforeAll(async () => {
    Test = (await import('@nestjs/testing')).Test;
    AppModule = (await import('../app.module.js')).AppModule;
  }, 60_000);

  it('fails AppModule compile when JWT_SECRET is unset', async () => {
    await expect(
      Test.createTestingModule({ imports: [AppModule] }).compile(),
    ).rejects.toThrow(/JWT_SECRET/);
  }, 30_000);
});
