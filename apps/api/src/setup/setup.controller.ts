import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { isModuleId, MODULE_PROFILES, ModuleId } from '@scenorya/shared';
import { Public, ScenoryaRequest } from '../common/access';
import { parse, zEmail, zOptText, zPassword } from '../common/validation';
import { SetupService } from './setup.service';
import { setSessionCookie } from '../auth/auth.controller';
import { loadConfig } from '../config';

export const zSmtp = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: zOptText(254),
  password: z.string().max(512).optional().nullable(),
  from: z.string().trim().min(3).max(254),
});

@ApiTags('Installation')
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Public()
  @Get('status')
  async status() {
    return { needsSetup: await this.setup.needsSetup(), version: loadConfig().version, profiles: MODULE_PROFILES };
  }

  @Public()
  @Post()
  async run(@Body() body: unknown, @Req() req: ScenoryaRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(
      z.object({
        setupToken: z.string().min(1).max(200),
        admin: z.object({ email: zEmail, displayName: z.string().trim().min(2).max(120), password: zPassword }),
        association: z.object({ name: z.string().trim().min(2).max(160), email: zOptText(254), city: zOptText(120) }),
        modules: z.array(z.string()).max(30).refine((a) => a.every(isModuleId), 'Module inconnu'),
        smtp: zSmtp.optional().nullable(),
      }),
      body,
    );
    const result = await this.setup.run({ ...input, modules: input.modules as ModuleId[] }, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
    setSessionCookie(res, result.session.token);
    return { csrfToken: result.session.session.csrfToken, associationId: result.association.id, activated: result.activated };
  }
}
