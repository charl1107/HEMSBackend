import { ConfigService } from '@nestjs/config';

export const DEV_JWT_SECRET_FALLBACK = 'dev-secret-change-me';
export const LEGACY_PLACEHOLDER_JWT_SECRET =
  'change-me-to-a-long-random-string-before-production';

const INSECURE_SECRETS: readonly string[] = [
  DEV_JWT_SECRET_FALLBACK,
  LEGACY_PLACEHOLDER_JWT_SECRET,
];

export function resolveJwtSecret(config: ConfigService): string {
  const secret = (config.get<string>('JWT_SECRET') ?? '').trim();
  if (!secret || INSECURE_SECRETS.includes(secret)) {
    throw new Error(
      'JWT_SECRET must be set to a unique non-placeholder value; known default secrets are rejected in every environment',
    );
  }
  return secret;
}
