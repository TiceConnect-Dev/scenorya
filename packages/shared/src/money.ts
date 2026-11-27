/**
 * Montants financiers : toujours des entiers en centimes. Aucune arithmétique
 * en nombres flottants ; la conversion depuis une saisie texte est exacte.
 */

/** « 12,5 » / « 12.50 » / « 1 234,56 € » → 1250 / 1250 / 123456. Renvoie null si invalide. */
export function parseEuros(input: string): number | null {
  const s = input.replace(/[\s  €]/g, '').replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** 123456 → « 1 234,56 € » (format français). */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

/** Saisie d'un montant à partir de centimes (« 12,50 »). */
export function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

export const PAYMENT_METHODS = {
  cash: 'Espèces',
  cheque: 'Chèque',
  transfer: 'Virement',
  card: 'Carte bancaire',
  online: 'Paiement en ligne',
  other: 'Autre',
} as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export const PERIOD_TYPES = {
  calendar_year: 'Année civile',
  fiscal_year: 'Exercice de l’association',
  rolling_12m: '12 mois à compter de l’adhésion',
  one_time: 'Ponctuelle (sans échéance)',
} as const;
export type PeriodType = keyof typeof PERIOD_TYPES;

/**
 * Période couverte par une cotisation, en dates ISO (AAAA-MM-JJ).
 * `start` : date de référence ; `fiscalStartMonth` : 1 à 12.
 */
export function computePeriod(type: PeriodType, start: string, fiscalStartMonth = 1): { start: string; end: string | null } {
  const [y, mo, d] = start.split('-').map(Number);
  const iso = (yy: number, mm: number, dd: number) => {
    const dt = new Date(Date.UTC(yy, mm - 1, dd));
    return dt.toISOString().slice(0, 10);
  };
  switch (type) {
    case 'calendar_year':
      return { start: iso(y, 1, 1), end: iso(y, 12, 31) };
    case 'fiscal_year': {
      const fy = mo >= fiscalStartMonth ? y : y - 1;
      return { start: iso(fy, fiscalStartMonth, 1), end: iso(fy + 1, fiscalStartMonth, 0) };
    }
    case 'rolling_12m':
      return { start: iso(y, mo, d), end: iso(y + 1, mo, d - 1) };
    case 'one_time':
      return { start: iso(y, mo, d), end: null };
  }
}
