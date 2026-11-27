import { describe, expect, it } from 'vitest';
import { computePeriod, formatCents, parseEuros } from './money';

describe('montants', () => {
  it('convertit les saisies en centimes sans flottant', () => {
    expect(parseEuros('12')).toBe(1200);
    expect(parseEuros('12,5')).toBe(1250);
    expect(parseEuros('12.05')).toBe(1205);
    expect(parseEuros('1 234,56 €')).toBe(123456);
    expect(parseEuros('0,10')).toBe(10);
    expect(parseEuros('0,1') ).toBe(10);
    expect(parseEuros('19,99')).toBe(1999); // 19.99*100 = 1998.9999… en flottant
    expect(parseEuros('-5')).toBeNull();
    expect(parseEuros('12,345')).toBeNull();
    expect(parseEuros('abc')).toBeNull();
  });
  it('formate en français', () => {
    expect(formatCents(123456)).toBe('1 234,56 €');
    expect(formatCents(5)).toBe('0,05 €');
  });
});

describe('périodes de cotisation', () => {
  it('année civile', () => expect(computePeriod('calendar_year', '2026-05-12')).toEqual({ start: '2026-01-01', end: '2026-12-31' }));
  it('exercice commençant en septembre', () => {
    expect(computePeriod('fiscal_year', '2026-11-27', 9)).toEqual({ start: '2026-09-01', end: '2027-08-31' });
    expect(computePeriod('fiscal_year', '2026-03-01', 9)).toEqual({ start: '2025-09-01', end: '2026-08-31' });
  });
  it('12 mois glissants, y compris années bissextiles', () => {
    expect(computePeriod('rolling_12m', '2026-11-27')).toEqual({ start: '2026-11-27', end: '2027-11-26' });
    expect(computePeriod('rolling_12m', '2028-03-01')).toEqual({ start: '2028-03-01', end: '2029-02-28' });
  });
  it('ponctuelle', () => expect(computePeriod('one_time', '2026-06-01')).toEqual({ start: '2026-06-01', end: null }));
});
