import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';

export async function dispatchOutbox(pool: Pool, boss: PgBoss) {
  let dispatched = 0;
  for (let i = 0; i < 25; i++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string; kind: string }>(
        'SELECT id,kind FROM knowledge.outbox WHERE enqueued_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED',
      );
      const event = result.rows[0];
      if (!event) {
        await client.query('COMMIT');
        break;
      }
      await boss.send('knowledge.events', {
        eventId: event.id,
        kind: event.kind,
      });
      await client.query(
        'UPDATE knowledge.outbox SET enqueued_at=now() WHERE id=$1',
        [event.id],
      );
      await client.query('COMMIT');
      dispatched++;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return dispatched;
}

export async function acknowledgeEvent(pool: Pool, eventId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO knowledge.event_receipts(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',
      [eventId],
    );
    await client.query(
      'UPDATE knowledge.outbox SET delivered_at=COALESCE(delivered_at,now()) WHERE id=$1',
      [eventId],
    );
    await client.query('COMMIT');
    return inserted.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
