import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Pool } from 'pg';
import { createDb, createPool, DB, PG_POOL } from './db/db';
import { loadConfig } from './config';
import { AccessGuard } from './common/access.guard';
import { SessionService } from './auth/session.service';
import { AuthController } from './auth/auth.controller';
import { PermissionService } from './admin/permission.service';
import { AuditService } from './audit/audit.service';
import { ModulesService } from './modules/modules.service';
import { AdminModulesController, ContextController, InstanceModulesController } from './modules/modules.controller';
import { AssociationsService } from './associations/associations.service';
import { SetupService } from './setup/setup.service';
import { SetupController } from './setup/setup.controller';
import { SettingsService } from './system/settings.service';
import { BackupService } from './system/backup.service';
import { SystemController } from './system/system.controller';
import { AdminRolesController, AdminUsersController } from './admin/users-roles.controller';
import { AdminAssociationController, AdminAuditController } from './admin/admin.controller';
import { HubController } from './hub/hub.controller';
import { MembersController } from './asso/members.controller';
import { DuesController, PlansController } from './asso/dues.controller';
import { CardsController, FieldsController, GroupsController } from './asso/groups-fields-cards.controller';
import { AgendaController } from './agenda/agenda.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

/**
 * Monolithe modulaire : un seul déploiement, une seule base, un seul système
 * d'authentification et de permissions. Chaque module métier est un ensemble
 * de contrôleurs soumis à la garde globale (AccessGuard).
 */
@Module({
  controllers: [
    SetupController, AuthController, ContextController, HubController,
    AdminModulesController, AdminUsersController, AdminRolesController, AdminAuditController, AdminAssociationController,
    InstanceModulesController, SystemController,
    MembersController, PlansController, DuesController, GroupsController, FieldsController, CardsController,
    AgendaController,
  ],
  providers: [
    { provide: PG_POOL, useFactory: () => createPool(loadConfig().DATABASE_URL) },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => createDb(pool) },
    { provide: APP_GUARD, useClass: AccessGuard },
    SessionService, PermissionService, AuditService, ModulesService, AssociationsService,
    SetupService, SettingsService, BackupService, RealtimeGateway, PoolLifecycle,
  ],
})
export class AppModule {}
