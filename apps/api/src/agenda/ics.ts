/** Génération iCalendar (RFC 5545) minimale et conforme : échappement, pliage des lignes, CRLF. */

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (key: string) => key.replace(/-/g, '');

function fold(line: string) {
  // 75 octets maximum par ligne, continuation par une espace.
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = ch;
    } else current += ch;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export interface IcsEvent {
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  startKey: string;
  endKey: string;
  category?: string;
  updatedAt: Date;
}

export function buildIcs(calendarName: string, items: IcsEvent[]) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TiceConnect//Scenorya//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calendarName)}`, 'X-WR-TIMEZONE:Europe/Paris'];
  const now = stamp(new Date());
  for (const e of items) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${now}`, `LAST-MODIFIED:${stamp(e.updatedAt)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.startKey)}`, `DTEND;VALUE=DATE:${dateOnly(e.endKey)}`);
    else lines.push(`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`);
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.category) lines.push(`CATEGORIES:${esc(e.category)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
