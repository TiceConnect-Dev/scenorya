import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { BRAND } from '@scenorya/shared';
import { DB, Db, DbOrTx } from '../db/db';
import { instanceSettings } from '../db/schema';
import { SecretBox } from '../common/crypto';
import { loadConfig } from '../config';
import { AuditService } from '../audit/audit.service';
import { BadRequest } from '../common/errors';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  password?: string | null;
  from: string;
}

interface StoredSmtp extends Omit<SmtpSettings, 'password'> {
  passwordEncrypted: string | null;
}

export function brandingDir() {
  const candidates = [process.env.BRANDING_DIR, resolve(__dirname, '../../../../branding'), resolve(process.cwd(), 'branding')];
  return candidates.find((c) => c && existsSync(join(c, 'modules.json'))) ?? resolve(process.cwd(), 'branding');
}

/** Gabarit HTML commun des e-mails, aux couleurs de Scenorya. */
export function emailLayout(title: string, bodyHtml: string) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:${BRAND.colors.background};font-family:Arial,Helvetica,sans-serif;color:${BRAND.colors.text}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #dde3ee;border-radius:6px">
<tr><td style="padding:20px 24px;border-bottom:3px solid ${BRAND.colors.blue}"><img src="cid:scenorya-logo" alt="Scenorya" width="200" style="display:block"></td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 12px;color:${BRAND.colors.navy}">${title}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#5b6b80;border-top:1px solid #dde3ee">${BRAND.name} — ${BRAND.slogan}<br>${BRAND.signature}</td></tr>
</table></td></tr></table></body></html>`;
}

@Injectable()
export class SettingsService {
  private box = new SecretBox(loadConfig().APP_SECRET);
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(instanceSettings).where(eq(instanceSettings.key, key));
    return (row?.value as T) ?? null;
  }

  async saveSmtp(tx: DbOrTx, input: SmtpSettings, actor: { id: string; label: string; ip?: string | null }) {
    const [existing] = await tx.select().from(instanceSettings).where(eq(instanceSettings.key, 'smtp'));
    const previous = existing?.value as StoredSmtp | undefined;
    // Mot de passe absent = conserver l'existant ; chaîne vide = supprimer.
    const passwordEncrypted =
      input.password === undefined || input.password === null
        ? previous?.passwordEncrypted ?? null
        : input.password === ''
          ? null
          : this.box.encrypt(input.password);
    const value: StoredSmtp = { host: input.host, port: input.port, secure: input.secure, user: input.user ?? null, from: input.from, passwordEncrypted };
    await tx
      .insert(instanceSettings)
      .values({ key: 'smtp', value })
      .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
    await this.audit.log(
      { associationId: null, actorId: actor.id, actorLabel: actor.label, action: 'settings.smtp.update', resourceType: 'settings', resourceId: 'smtp', summary: `Configuration SMTP : ${input.host}:${input.port}`, data: { host: input.host, port: input.port, user: input.user }, ip: actor.ip },
      tx,
    );
  }

  async smtpPublic() {
    const s = await this.get<StoredSmtp>('smtp');
    if (!s) return null;
    const { passwordEncrypted, ...rest } = s;
    return { ...rest, hasPassword: Boolean(passwordEncrypted) };
  }

  async transport() {
    const s = await this.get<StoredSmtp>('smtp');
    if (!s) throw BadRequest('SMTP_NOT_CONFIGURED', "La messagerie n'est pas configurée.");
    return {
      from: s.from,
      transporter: nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure,
        auth: s.user ? { user: s.user, pass: s.passwordEncrypted ? this.box.decrypt(s.passwordEncrypted) : '' } : undefined,
        connectionTimeout: 10_000,
      }),
    };
  }

  async sendTest(to: string) {
    const { from, transporter } = await this.transport();
    const logo = join(brandingDir(), 'derived', 'logos', 'scenorya-horizontal.png');
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'Scenorya — e-mail de test',
      text: 'La configuration de la messagerie de Scenorya fonctionne.',
      html: emailLayout('Messagerie configurée', '<p>La configuration de la messagerie de Scenorya fonctionne.</p>'),
      attachments: existsSync(logo) ? [{ filename: 'scenorya.png', path: logo, cid: 'scenorya-logo' }] : [],
    });
    return { messageId: info.messageId, accepted: info.accepted };
  }
}
