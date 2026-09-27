import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { hardenApp } from './security.js';
import { UPLOADS_ROOT } from './events/cover-file.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  hardenApp(app);
  app.useStaticAssets(UPLOADS_ROOT, { prefix: '/uploads' });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
