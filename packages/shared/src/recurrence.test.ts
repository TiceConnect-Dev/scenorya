import { describe, expect, it } from 'vitest';
import { expandOccurrences, zonedParts, zonedToUtc } from './recurrence';

const TZ = 'Europe/Paris';
const at = (iso: string) => new Date(iso);

describe('fuseau horaire', () => {
  it('convertit l’heure locale en UTC de part et d’autre du changement d’heure', () => {
    expect(zonedToUtc(2026, 1, 15, 19, 0, TZ).toISOString()).toBe('2026-01-15T18:00:00.000Z'); // UTC+1
    expect(zonedToUtc(2026, 7, 15, 19, 0, TZ).toISOString()).toBe('2026-07-15T17:00:00.000Z'); // UTC+2
    expect(zonedParts(at('2026-03-29T17:00:00Z'), TZ).hour).toBe(19);
  });
});

describe('récurrences', () => {
  it('une répétition hebdomadaire reste à 19 h après le passage à l’heure d’été', () => {
    const start = zonedToUtc(2026, 3, 19, 19, 0, TZ); // jeudi 19 mars
    const end = new Date(start.getTime() + 3 * 3600_000);
    const occ = expandOccurrences({ start, end, rule: { freq: 'weekly', interval: 1 } }, at('2026-03-01T00:00:00Z'), at('2026-04-10T00:00:00Z'), TZ);
    expect(occ.map((o) => o.key)).toEqual(['2026-03-19', '2026-03-26', '2026-04-02', '2026-04-09']);
    for (const o of occ) {
      expect(zonedParts(o.start, TZ).hour).toBe(19);
      expect(o.end.getTime() - o.start.getTime()).toBe(3 * 3600_000);
    }
  });

  it('plusieurs jours par semaine, une semaine sur deux, jusqu’à une date', () => {
    const start = zonedToUtc(2026, 9, 7, 18, 30, TZ); // lundi 7 septembre
    const occ = expandOccurrences(
      { start, end: new Date(start.getTime() + 7200_000), rule: { freq: 'weekly', interval: 2, byWeekday: [1, 3], until: '2026-10-07' } },
      at('2026-09-01T00:00:00Z'), at('2026-12-31T00:00:00Z'), TZ,
    );
    expect(occ.map((o) => o.key)).toEqual(['2026-09-07', '2026-09-09', '2026-09-21', '2026-09-23', '2026-10-05', '2026-10-07']);
  });

  it('nombre d’occurrences, exceptions et fenêtre', () => {
    const start = zonedToUtc(2026, 1, 5, 10, 0, TZ);
    const ev = { start, end: new Date(start.getTime() + 3600_000), rule: { freq: 'daily' as const, interval: 1, count: 5 }, exdates: ['2026-01-07'] };
    expect(expandOccurrences(ev, at('2026-01-01T00:00:00Z'), at('2026-02-01T00:00:00Z'), TZ).map((o) => o.key)).toEqual(['2026-01-05', '2026-01-06', '2026-01-08', '2026-01-09']);
    expect(expandOccurrences(ev, at('2026-01-08T00:00:00Z'), at('2026-01-09T00:00:00Z'), TZ).map((o) => o.key)).toEqual(['2026-01-08']);
  });

  it('mensuel : un 31 est sauté les mois qui n’en ont pas', () => {
    const start = zonedToUtc(2026, 1, 31, 20, 0, TZ);
    const occ = expandOccurrences({ start, end: new Date(start.getTime() + 3600_000), rule: { freq: 'monthly', interval: 1, count: 4 } }, at('2026-01-01T00:00:00Z'), at('2027-01-01T00:00:00Z'), TZ);
    expect(occ.map((o) => o.key)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });

  it('événement simple', () => {
    const ev = { start: at('2026-05-01T08:00:00Z'), end: at('2026-05-01T10:00:00Z'), rule: null };
    expect(expandOccurrences(ev, at('2026-05-01T09:00:00Z'), at('2026-05-02T00:00:00Z'))).toHaveLength(1);
    expect(expandOccurrences(ev, at('2026-05-01T10:00:00Z'), at('2026-05-02T00:00:00Z'))).toHaveLength(0);
  });
});
