/**
 * Récurrences d'événements, calculées en heure locale de l'association
 * (par défaut Europe/Paris) : une répétition hebdomadaire à 19 h reste à 19 h
 * après le passage à l'heure d'été ou d'hiver.
 */

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  /** Tous les N jours / semaines / mois. */
  interval: number;
  /** Jours de la semaine (0 = dimanche … 6 = samedi), pour `weekly`. */
  byWeekday?: number[];
  /** Date locale (AAAA-MM-JJ) incluse de fin, ou nombre d'occurrences. */
  until?: string | null;
  count?: number | null;
}

export const DEFAULT_TIMEZONE = 'Europe/Paris';
const MAX_OCCURRENCES = 1000;

/** Composantes de date/heure locales d'un instant dans un fuseau. */
export function zonedParts(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** Instant UTC correspondant à une heure locale donnée dans un fuseau. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (t: number) => {
    const z = zonedParts(new Date(t), timeZone);
    return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // second passage : précision autour des changements d'heure
  return new Date(t);
}

/** Date locale (AAAA-MM-JJ) d'un instant. */
export function localDate(date: Date, timeZone: string) {
  const z = zonedParts(date, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

export interface Occurrence {
  start: Date;
  end: Date;
  /** Date locale de l'occurrence : identifiant stable (exceptions). */
  key: string;
}

/**
 * Occurrences d'un événement entre `from` et `to` (instants).
 * `exdates` : dates locales des occurrences annulées.
 */
export function expandOccurrences(
  ev: { start: Date; end: Date; rule: RecurrenceRule | null; exdates?: string[] },
  from: Date,
  to: Date,
  timeZone = DEFAULT_TIMEZONE,
): Occurrence[] {
  const duration = ev.end.getTime() - ev.start.getTime();
  const ex = new Set(ev.exdates ?? []);
  if (!ev.rule) {
    const key = localDate(ev.start, timeZone);
    return ev.end > from && ev.start < to && !ex.has(key) ? [{ start: ev.start, end: ev.end, key }] : [];
  }
  const r = ev.rule;
  const interval = Math.max(1, Math.floor(r.interval || 1));
  const base = zonedParts(ev.start, timeZone);
  const out: Occurrence[] = [];
  let produced = 0;
  const baseDay = Date.UTC(base.year, base.month - 1, base.day);
  const dayMs = 86_400_000;
  const weekdays = r.freq === 'weekly' ? (r.byWeekday?.length ? [...new Set(r.byWeekday)].sort() : [new Date(baseDay).getUTCDay()]) : null;

  for (let i = 0; i < 20_000 && produced < MAX_OCCURRENCES; i++) {
    let candidates: number[] = [];
    if (r.freq === 'daily') candidates = [baseDay + i * interval * dayMs];
    else if (r.freq === 'weekly') {
      // Semaine i (à partir du lundi de la semaine de départ), toutes les `interval` semaines.
      const startDow = (new Date(baseDay).getUTCDay() + 6) % 7;
      const monday = baseDay - startDow * dayMs + i * interval * 7 * dayMs;
      candidates = weekdays!.map((wd) => monday + ((wd + 6) % 7) * dayMs).filter((d) => d >= baseDay);
    } else {
      const m = base.month - 1 + i * interval;
      const y = base.year + Math.floor(m / 12);
      const mm = ((m % 12) + 12) % 12;
      const lastDay = new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
      if (base.day <= lastDay) candidates = [Date.UTC(y, mm, base.day)]; // un 31 n'existe pas chaque mois : sauté
    }
    let stop = false;
    for (const day of candidates) {
      const d = new Date(day);
      const key = d.toISOString().slice(0, 10);
      if (r.until && key > r.until) { stop = true; break; }
      if (r.count && produced >= r.count) { stop = true; break; }
      produced++;
      const start = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), base.hour, base.minute, timeZone);
      if (start >= to) { stop = true; break; }
      const end = new Date(start.getTime() + duration);
      if (end > from && !ex.has(key)) out.push({ start, end, key });
    }
    if (stop) break;
  }
  return out;
}

export const EVENT_CATEGORIES = {
  rehearsal: { label: 'Répétition', color: '#7539B2' },
  performance: { label: 'Représentation', color: '#B52668' },
  meeting: { label: 'Réunion', color: '#1765AD' },
  general_assembly: { label: 'Assemblée générale', color: '#102540' },
  permanence: { label: 'Permanence', color: '#008780' },
  deadline: { label: 'Échéance administrative', color: '#C63D41' },
  public: { label: 'Événement public', color: '#C77A08' },
  maintenance: { label: 'Maintenance', color: '#526C85' },
  other: { label: 'Autre', color: '#4f6077' },
} as const;
export type EventCategory = keyof typeof EVENT_CATEGORIES;
