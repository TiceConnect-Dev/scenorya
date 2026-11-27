import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BRAND, MODULES } from '@scenorya/shared';
import { Authenticated, Ctx, Public, RequestContext, ScenoryaRequest, SESSION_COOKIE } from '../common/access';
import { parse, zEmail, zPassword } from '../common/validation';
import { AppError, BadRequest, NotFound } from '../common/errors';
import { DB, Db } from '../db/db';
import { sessions, users } from '../db/schema';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';
import { AssociationsService } from '../associations/associations.service';
import { loadConfig } from '../config';
import { HttpStatus } from '@nestjs/common';

export function setSessionCookie(res: Response, token: string) {
  const cfg = loadConfig();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.cookieSecure,
    path: '/',
    maxAge: cfg.SESSION_TTL_HOURS * 3600_000 * 14,
  });
}

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly associations: AssociationsService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: ScenoryaRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(z.object({ email: zEmail, password: z.string().min(1).max(256) }), body);
    const keys = [`ip:${req.ip}`, `email:${input.email}`];
    if (await this.sessions.isLocked(keys)) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives. Réessayez dans 15 minutes.');
    }
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${input.email}`);
    // Vérification systématique (hash factice) pour limiter les attaques temporelles.
    const ok = user
      ? await this.sessions.verifyPassword(user.passwordHash, input.password)
      : await this.sessions.dummyVerify(input.password);
    if (!user || !ok || user.status !== 'active') {
      await this.sessions.recordAttempt(keys, false);
      await this.audit.log({ associationId: null, actorId: user?.id ?? null, actorLabel: input.email, action: 'auth.login.failure', summary: `Échec de connexion pour ${input.email}`, ip: req.ip });
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Identifiants incorrects.');
    }
    await this.sessions.recordAttempt(keys, true);
    const { token, session } = await this.sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(res, token);
    await this.audit.log({ associationId: null, actorId: user.id, actorLabel: user.displayName, action: 'auth.login', summary: `Connexion de ${user.displayName}`, ip: req.ip });
    return { csrfToken: session.csrfToken, mustChangePassword: user.mustChangePassword };
  }

  @Authenticated({ allowPasswordChange: true })
  @Post('logout')
  @HttpCode(200)
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(ctx.session!.id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Authenticated({ allowPasswordChange: true })
  @Get('me')
  async me(@Ctx() ctx: RequestContext) {
    return {
      user: ctx.user,
      csrfToken: ctx.session!.csrfToken,
      associations: await this.associations.listForUser(ctx.user!.id),
      instance: { version: loadConfig().version, edition: BRAND.edition, modules: MODULES.length },
    };
  }

  @Authenticated({ allowPasswordChange: true })
  @Post('password')
  @HttpCode(200)
  async changePassword(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: ScenoryaRequest) {
    const input = parse(z.object({ current: z.string().min(1), next: zPassword }), body);
    const [user] = await this.db.select().from(users).where(eq(users.id, ctx.user!.id));
    if (!(await this.sessions.verifyPassword(user.passwordHash, input.current))) {
      throw BadRequest('INVALID_PASSWORD', 'Mot de passe actuel incorrect.');
    }
    if (input.current === input.next) throw BadRequest('SAME_PASSWORD', 'Le nouveau mot de passe doit être différent.');
    await this.db
      .update(users)
      .set({ passwordHash: await this.sessions.hashPassword(input.next), mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await this.sessions.revokeAllForUser(user.id, ctx.session!.id);
    await this.audit.log({ associationId: null, actorId: user.id, actorLabel: user.displayName, action: 'auth.password.change', summary: `Changement de mot de passe de ${user.displayName}`, ip: req.ip });
    return { ok: true };
  }

  @Authenticated()
  @Get('sessions')
  async listSessions(@Ctx() ctx: RequestContext) {
    const items = await this.sessions.listActive(ctx.user!.id);
    return items.map((s) => ({ ...s, current: s.id === ctx.session!.id }));
  }

  @Authenticated()
  @Delete('sessions/:id')
  async revokeSession(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const [s] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, ctx.user!.id)))
      .catch(() => []);
    if (!s) throw NotFound('Session introuvable.');
    await this.sessions.revoke(id);
    return { ok: true };
  }
}
