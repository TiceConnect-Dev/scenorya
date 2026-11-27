import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { createDb, createPool, runMigrations } from './db/db';
import { brandingDir } from './system/settings.service';

export async function migrateIfNeeded() {
  const cfg = loadConfig();
  if (cfg.RUN_MIGRATIONS !== 'true') return;
  const pool = createPool(cfg.DATABASE_URL);
  try {
    await runMigrations(createDb(pool));
  } finally {
    await pool.end();
  }
}

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: opts.logger === false ? false : ['log', 'warn', 'error'],
    bodyParser: false,
  });
  if (cfg.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // En HTTP simple (réseau local), ne pas forcer HTTPS sur les ressources.
          upgradeInsecureRequests: cfg.PUBLIC_URL.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('API Scenorya')
    .setDescription('Gestion associative, culturelle et événementielle — Une application de TiceConnect. Authentification par cookie de session + en-tête X-CSRF-Token ; contexte d’association par l’en-tête X-Scenorya-Association.')
    .setVersion(cfg.version)
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));

  // Pack graphique servi localement (logos, icônes) — aucune dépendance externe.
  app.use('/branding', express.static(brandingDir(), { maxAge: '7d', index: false }));

  // Interface web (build Vite) servie par le même processus, avec repli SPA.
  const webDist = cfg.WEB_DIST ? resolve(cfg.WEB_DIST) : join(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/branding')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  } else {
    new Logger('Web').warn(`Interface web non trouvée (${webDist}) : seule l'API est servie.`);
  }
  return app;
}
