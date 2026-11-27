import { Body, Controller, Get, Inject, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { grantsCover } from '@scenorya/shared';
import { Access, AssocContext, AssocCtx } from '../common/access';
import { parse, zOptText } from '../common/validation';
import { Forbidden } from '../common/errors';
import { DB, Db } from '../db/db';
import { associations } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { SecretBox } from '../common/crypto';
import { loadConfig } from '../config';
import { toCsv } from '../common/csv';

const zAuditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().max(100).optional(),
  action: z.string().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@ApiTags("Scenorya Admin — Journal d'audit")
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Access('admin', 'admin.audit.read')
  @Get()
  list(@AssocContext() c: AssocCtx, @Query() query: unknown) {
    return this.audit.list(c.association.id, parse(zAuditQuery, query));
  }

  @Access('admin', 'admin.audit.read')
  @Get('verify')
  verify(@AssocContext() c: AssocCtx) {
    return this.audit.verify(c.association.id);
  }

  @Access('admin', 'admin.audit.export')
  @Get('export.csv')
  async export(@AssocContext() c: AssocCtx, @Query() query: unknown, @Res() res: Response) {
    const q = parse(zAuditQuery, query);
    const { items } = await this.audit.list(c.association.id, { ...q, page: 1, pageSize: 10000 });
    await this.audit.log({ associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'audit.export', summary: `Export du journal d'audit (${items.length} entrées)`, ip: c.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="journal-audit.csv"');
    res.send(
      toCsv(
        ['Date', 'Utilisateur', 'Action', 'Ressource', 'Identifiant', 'Résumé', 'IP', 'Empreinte'],
        items.map((i) => [i.createdAt.toISOString(), i.actorLabel ?? '', i.action, i.resourceType ?? '', i.resourceId ?? '', i.summary, i.ip ?? '', i.hash]),
      ),
    );
  }
}

const zAssociation = z.object({
  name: z.string().trim().min(2).max(160),
  shortName: zOptText(60),
  legalName: zOptText(200),
  rna: z.string().trim().regex(/^(W\d{9})?$/, 'Le numéro RNA a la forme W123456789').optional().nullable().transform((v) => v || null),
  siret: z.string().trim().regex(/^(\d{14})?$/, 'Le SIRET comporte 14 chiffres').optional().nullable().transform((v) => v || null),
  email: zOptText(254),
  phone: zOptText(40),
  website: zOptText(254),
  addressLine: zOptText(255),
  postalCode: zOptText(20),
  city: zOptText(120),
  country: z.string().trim().max(80).default('France'),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur hexadécimale attendue'),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  insurance: zOptText(500),
  iban: z.string().trim().max(40).optional().nullable(),
  bic: zOptText(11),
});

@ApiTags("Scenorya Admin — Association")
@Controller('admin/association')
export class AdminAssociationController {
  private box = new SecretBox(loadConfig().APP_SECRET);
  constructor(@Inject(DB) private readonly db: Db, private readonly audit: AuditService) {}

  @Access('admin', 'admin.association.read')
  @Get()
  async get(@AssocContext() c: AssocCtx) {
    const [a] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    const { ibanEncrypted, ...rest } = a;
    const sensitive = grantsCover(c.grants, 'admin.association.sensitive');
    let iban: string | null = null;
    if (ibanEncrypted) {
      const plain = this.box.decrypt(ibanEncrypted);
      iban = sensitive ? plain : `•••• ${plain.slice(-4)}`;
    }
    return { ...rest, iban, canSeeSensitive: sensitive };
  }

  @Access('admin', 'admin.association.update')
  @Put()
  async update(@AssocContext() c: AssocCtx, @Body() body: unknown) {
    const input = parse(zAssociation, body);
    const { iban, ...fields } = input;
    const patch: Partial<typeof associations.$inferInsert> = { ...fields, updatedAt: new Date() };
    if (iban !== undefined && !iban?.startsWith('••••')) {
      if (!grantsCover(c.grants, 'admin.association.sensitive')) {
        throw Forbidden('PERMISSION_DENIED', 'La modification des coordonnées bancaires requiert un droit spécifique.');
      }
      const normalized = iban ? iban.replace(/\s+/g, '').toUpperCase() : null;
      if (normalized && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalized)) {
        throw Forbidden('INVALID_IBAN', 'IBAN invalide.');
      }
      patch.ibanEncrypted = normalized ? this.box.encrypt(normalized) : null;
    }
    const [before] = await this.db.select().from(associations).where(eq(associations.id, c.association.id));
    await this.db.update(associations).set(patch).where(eq(associations.id, c.association.id));
    const changed = Object.keys(fields).filter((k) => (before as Record<string, unknown>)[k] !== (fields as Record<string, unknown>)[k]);
    await this.audit.log({
      associationId: c.association.id, actorId: c.user.id, actorLabel: c.user.displayName, action: 'association.update', resourceType: 'association', resourceId: c.association.id,
      summary: `Mise à jour de la fiche de l'association`, data: { fields: changed, bankDetailsChanged: 'ibanEncrypted' in patch }, ip: c.ip,
    });
    return this.get(c);
  }
}
