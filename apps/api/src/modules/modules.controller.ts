import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { canSeeModule, MODULES } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx, Ctx, MemberOnly, RequestContext, SuperAdminOnly } from '../common/access';
import { parse } from '../common/validation';
import { ModulesService } from './modules.service';

const actorOf = (c: { user: { id: string; displayName: string }; ip?: string | null }) => ({ id: c.user.id, label: c.user.displayName, ip: c.ip ?? null });

@ApiTags('Contexte')
@Controller('context')
export class ContextController {
  /**
   * Contexte de l'association courante pour le client : états des modules,
   * permissions de l'utilisateur et modules visibles (lanceur, menus, widgets).
   */
  @MemberOnly()
  @Get()
  get(@AssocContext() c: AssocCtx) {
    const visible = MODULES.filter((m) => {
      if (m.id === 'system') return c.user.isSuperAdmin;
      return c.modules[m.id].usable && canSeeModule(c.grants, m.id);
    }).map((m) => m.id);
    return { association: c.association, grants: c.grants, modules: c.modules, visibleModules: visible, isSuperAdmin: c.user.isSuperAdmin };
  }
}

@ApiTags('Scenorya Admin — Modules')
@Controller('admin/modules')
export class AdminModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Access('admin', 'admin.modules.read')
  @Get()
  async catalogue(@AssocContext() c: AssocCtx) {
    return { items: await this.modules.catalogue(c.association.id) };
  }

  @Access('admin', 'admin.modules.read')
  @Get('history')
  async history(@AssocContext() c: AssocCtx) {
    return (await this.modules.history(c.association.id)).map((r) => ({ ...r.h, actor: r.actor }));
  }

  @Access('admin', 'admin.modules.read', { write: false })
  @Post(':id/preview-activation')
  @HttpCode(200)
  previewActivation(@AssocContext() c: AssocCtx, @Param('id') id: string) {
    return this.modules.previewActivation(c.association.id, id);
  }

  @Access('admin', 'admin.modules.admin')
  @Post(':id/activate')
  @HttpCode(200)
  activate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ confirmDependencies: z.boolean().optional() }), body ?? {});
    return this.modules.activate(c.association.id, id, input, actorOf(c));
  }

  @Access('admin', 'admin.modules.read', { write: false })
  @Post(':id/preview-deactivation')
  @HttpCode(200)
  previewDeactivation(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ mode: z.enum(['inactive', 'readonly']).default('inactive') }), body ?? {});
    return this.modules.previewDeactivation(c.association.id, id, input.mode);
  }

  @Access('admin', 'admin.modules.admin')
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@AssocContext() c: AssocCtx, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({ mode: z.enum(['inactive', 'readonly']).default('inactive'), confirmDependents: z.boolean().optional(), acknowledgeWarnings: z.boolean().optional() }),
      body ?? {},
    );
    return this.modules.deactivate(c.association.id, id, input, actorOf(c));
  }
}

@ApiTags('Scenorya System — Modules de l’instance')
@Controller('system/instance-modules')
export class InstanceModulesController {
  constructor(private readonly modules: ModulesService) {}

  @SuperAdminOnly()
  @Get()
  list() {
    return this.modules.instanceCatalogue();
  }

  @SuperAdminOnly()
  @Put(':id')
  set(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ enabled: z.boolean() }), body);
    return this.modules.setInstanceModule(id, input.enabled, { id: ctx.user!.id, label: ctx.user!.displayName });
  }
}
