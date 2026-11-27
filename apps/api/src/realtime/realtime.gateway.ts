import { Inject, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { grantsCover } from '@scenorya/shared';
import { DB, Db } from '../db/db';
import { regieCuesheets } from '../db/schema';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { SESSION_COOKIE } from '../common/access';
import { SessionService } from '../auth/session.service';
import { PermissionService } from '../admin/permission.service';
import { ModulesService, ModuleChangeEvent } from '../modules/modules.service';

function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Canal temps réel (Socket.IO, chemin /api/realtime).
 * Authentification par le cookie de session lors de la poignée de main ;
 * l'abonnement à une association vérifie l'appartenance côté serveur.
 * Diffuse `modules:changed` pour que les clients rechargent menus et lanceur.
 */
@WebSocketGateway({ path: '/api/realtime', cors: false })
export class RealtimeGateway implements OnGatewayInit, OnModuleInit {
  @WebSocketServer() server: Server;

  constructor(private readonly sessions: SessionService, private readonly permissions: PermissionService, private readonly modules: ModulesService, @Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    this.modules.events.on('changed', (e: ModuleChangeEvent) => {
      if (!this.server) return;
      if (e.associationId) this.server.to(`assoc:${e.associationId}`).emit('modules:changed', e);
      else this.server.emit('modules:changed', e);
    });
  }

  /** Authentification avant l'établissement de la connexion (refus si pas de session valide). */
  afterInit(server: Server) {
    server.use((socket, next) => {
      this.sessions
        .resolve(readCookie(socket.handshake.headers.cookie, SESSION_COOKIE))
        .then((auth) => {
          if (!auth) return next(new Error('UNAUTHENTICATED'));
          socket.data.userId = auth.user.id;
          next();
        })
        .catch(() => next(new Error('UNAUTHENTICATED')));
    });
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { associationId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId || typeof body?.associationId !== 'string') return { ok: false };
    const membership = await this.permissions.membership(userId, body.associationId).catch(() => null);
    if (!membership) return { ok: false, code: 'NOT_MEMBER' };
    for (const room of client.rooms) if (room.startsWith('assoc:')) await client.leave(room);
    await client.join(`assoc:${body.associationId}`);
    return { ok: true };
  }

  /** Suivi en direct d'une conduite : membre, droit de lecture des séances, module utilisable, conduite de l'association. */
  @SubscribeMessage('regie:join')
  async regieJoin(@ConnectedSocket() client: Socket, @MessageBody() body: { associationId?: string; cuesheetId?: string }) {
    const userId = client.data.userId as string | undefined;
    if (!userId || typeof body?.associationId !== 'string' || typeof body?.cuesheetId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.cuesheetId)) return { ok: false };
    const membership = await this.permissions.membership(userId, body.associationId).catch(() => null);
    if (!membership) return { ok: false, code: 'NOT_MEMBER' };
    if (!grantsCover(await this.permissions.grants(membership.id), 'regie.runs.read')) return { ok: false, code: 'PERMISSION_DENIED' };
    if (!(await this.modules.resolved(body.associationId)).regie.usable) return { ok: false, code: 'MODULE_UNAVAILABLE' };
    const [sheet] = await this.db.select({ id: regieCuesheets.id }).from(regieCuesheets).where(and(eq(regieCuesheets.id, body.cuesheetId), eq(regieCuesheets.associationId, body.associationId)));
    if (!sheet) return { ok: false, code: 'NOT_FOUND' };
    for (const room of client.rooms) if (room.startsWith('regie:')) await client.leave(room);
    await client.join(`regie:${body.cuesheetId}`);
    return { ok: true };
  }

  @SubscribeMessage('regie:leave')
  async regieLeave(@ConnectedSocket() client: Socket) {
    for (const room of client.rooms) if (room.startsWith('regie:')) await client.leave(room);
    return { ok: true };
  }

  /** Diffusion à tous les postes qui suivent une conduite. */
  emitRegie(cuesheetId: string, event: string, payload: unknown) {
    this.server?.to(`regie:${cuesheetId}`).emit(event, payload);
  }
}
