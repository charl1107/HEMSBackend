import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

export interface CorsEnv {
  FRONTEND_URL?: string;
  NODE_ENV?: string;
}

export interface ResolvedCorsOptions {
  origin: string[] | false;
  credentials: boolean;
}

export function resolveCorsOptions(env: CorsEnv): ResolvedCorsOptions {
  const allowlist = (env.FRONTEND_URL ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (allowlist.includes('*')) {
    throw new Error(
      'FRONTEND_URL must not contain "*" — CORS is locked to an explicit allowlist',
    );
  }
  if (allowlist.length === 0) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'FRONTEND_URL must be set to the production frontend origin(s) when NODE_ENV=production',
      );
    }
    return { origin: false, credentials: false };
  }
  return { origin: allowlist, credentials: true };
}

export function hardenApp(
  app: INestApplication,
  env: CorsEnv = process.env,
): void {
  app.enableCors(resolveCorsOptions(env));
  // Express-only; helmet's hidePoweredBy was removed upstream.
  app.getHttpAdapter().getInstance().disable?.('x-powered-by');
  app.use(
    helmet({
      // The SPA on FRONTEND_URL loads cover images from this API cross-origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
