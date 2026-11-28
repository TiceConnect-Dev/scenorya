import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';

export interface Availability { itemId: string; quantity: number; outOfService: number; reserved: number; available: number }

/**
 * Disponibilité du matériel sur un créneau : quantité possédée, moins les unités hors service
 * (interventions de maintenance ouvertes), moins les quantités déjà réservées sur des prêts
 * qui chevauchent le créneau (demandes en attente comprises, prêts non rendus compris).
 */
export async function availability(db: DbOrTx, associationId: string, itemIds: string[] | null, start: Date, end: Date, excludeBookingId?: string): Promise<Map<string, Availability>> {
  const rows = await db.execute<{ id: string; quantity: number; out_of_service: number; reserved: number }>(sql`
    select i.id, i.quantity,
      coalesce((select sum(t.units_out) from maintenance_tickets t where t.item_id = i.id and t.status not in ('done', 'cancelled')), 0)::int as out_of_service,
      coalesce((select sum(bi.quantity) from booking_items bi join bookings b on b.id = bi.booking_id
        where bi.item_id = i.id and b.status in ('pending', 'confirmed') and b.returned_at is null
          and ((b.start_at < ${end} and b.end_at > ${start}) or b.checked_out_at is not null)
          ${excludeBookingId ? sql`and b.id <> ${excludeBookingId}` : sql``}), 0)::int as reserved
    from stock_items i
    where i.association_id = ${associationId} and i.archived_at is null ${itemIds ? sql`and i.id in ${itemIds.length ? itemIds : ['00000000-0000-0000-0000-000000000000']}` : sql``}`);
  return new Map(rows.rows.map((r) => [r.id, {
    itemId: r.id, quantity: r.quantity, outOfService: r.out_of_service, reserved: r.reserved,
    available: Math.max(0, r.quantity - r.out_of_service - r.reserved),
  }]));
}
