import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, gte, isNull, sql, count } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import { DB, Db } from '../db/db';
import { loginAttempts, sessions, users } from '../db/schema';
import { randomToken, sha256 } from '../common/crypto';
import { loadConfig } from '../config';
import type { AuthUser } from '../common/access';

/** Seuils d'échecs sur 15 minutes : par compte (e-mail) et par adresse IP (réseaux partagés). */
const MAX_FAILURES = { email: 5, ip: 30 } as const;
const WINDOW_MINUTES = 15;

@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  hashPassword(password: string) {
    return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  verifyPassword(hashValue: string, password: string) {
    return verify(hashValue, password).catch(() => false);
  }

  private dummyHash?: Promise<string>;
  /** Vérification factice (compte inexistant) : temps de réponse comparable à un vrai essai. */
  async dummyVerify(password: string) {
    this.dummyHash ??= this.hashPassword(randomToken());
    await this.verifyPassword(await this.dummyHash, password);
    return false;
  }

  /** Nombre d'échecs récents pour une clé (adresse IP ou e-mail). */
  async recentFailures(key: string) {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
    const [r] = await this.db
      .select({ n: count() })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.key, key), eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
    return r.n;
  }

  async isLocked(keys: string[]) {
    for (const k of keys) {
      const limit = k.startsWith('ip:') ? MAX_FAILURES.ip : MAX_FAILURES.email;
      if ((await this.recentFailures(k)) >= limit) return true;
    }
    return false;
  }

  async recordAttempt(keys: string[], success: boolean) {
    await this.db.insert(loginAttempts).values(keys.map((key) => ({ key, success })));
    if (success) {
      // Une connexion réussie efface les échecs liés au compte.
      for (const key of keys.filter((k) => k.startsWith('email:'))) {
        await this.db.delete(loginAttempts).where(and(eq(loginAttempts.key, key), eq(loginAttempts.success, false)));
      }
    }
  }

  async create(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const ttl = loadConfig().SESSION_TTL_HOURS;
    const [s] = await this.db
      .insert(sessions)
      .values({
        userId,
        tokenHash: sha256(token),
        csrfToken,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + ttl * 3600_000),
      })
      .returning();
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    return { token, session: s };
  }

  /** Résout une session valide à partir du jeton du cookie ; prolonge l'expiration glissante. */
  async resolve(token: string | undefined): Promise<{ user: AuthUser; session: { id: string; csrfToken: string } } | null> {
    if (!token || token.length > 200) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row || row.u.status !== 'active') return null;
    // Mise à jour de l'activité au plus une fois par minute.
    if (now.getTime() - row.s.lastSeenAt.getTime() > 60_000) {
      const ttl = loadConfig().SESSION_TTL_HOURS;
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + ttl * 3600_000) })
        .where(eq(sessions.id, row.s.id));
    }
    return {
      user: {
        id: row.u.id,
        email: row.u.email,
        displayName: row.u.displayName,
        isSuperAdmin: row.u.isSuperAdmin,
        mustChangePassword: row.u.mustChangePassword,
      },
      session: { id: row.s.id, csrfToken: row.s.csrfToken },
    };
  }

  async revoke(sessionId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined,
        ),
      );
  }

  listActive(userId: string) {
    return this.db
      .select({ id: sessions.id, ip: sessions.ip, userAgent: sessions.userAgent, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  }
}
