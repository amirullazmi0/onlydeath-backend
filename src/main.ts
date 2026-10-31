import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Requests arrive through the Next BFF; rate limits must see the buyer's IP, not its
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (process.env.FE_URL ?? 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
