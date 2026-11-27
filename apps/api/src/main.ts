import { Logger } from '@nestjs/common';
import { createApp, migrateIfNeeded } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const cfg = loadConfig();
  await migrateIfNeeded();
  const app = await createApp();
  await app.listen(cfg.PORT, '0.0.0.0');
  new Logger('Scenorya').log(`Scenorya ${cfg.version} — De la gestion aux applaudissements. Écoute sur le port ${cfg.PORT}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
