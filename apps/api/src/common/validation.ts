import { z } from 'zod';
import { BadRequest } from './errors';

/** Valide un corps de requête avec zod ; renvoie une erreur 400 détaillée en français. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw BadRequest(
      'VALIDATION_ERROR',
      'Données invalides.',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const zEmail = z.string().trim().toLowerCase().email('Adresse e-mail invalide').max(254);
export const zPassword = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caractères')
  .max(256)
  .refine((p) => /[a-z]/i.test(p) && /[0-9\W_]/.test(p), 'Le mot de passe doit mélanger lettres et chiffres ou symboles');
export const zOptText = (max = 255) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v === '' || v === undefined ? null : v));
export const zUuid = z.string().uuid();

/**
 * Schéma de modification partielle : chaque champ devient facultatif, SANS
 * valeur par défaut ni transformation d'une valeur absente. (`.partial()` de
 * zod appliquerait les `.default()` et les transformations `undefined → null`,
 * ce qui réinitialiserait silencieusement les champs non transmis.)
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let f = field as z.ZodTypeAny;
    while (f instanceof z.ZodDefault) f = f.unwrap() as z.ZodTypeAny;
    shape[key] = f.optional();
  }
  return z.object(shape).strip() as unknown as z.ZodType<Partial<z.output<z.ZodObject<T>>>>;
}
