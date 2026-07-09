import { getDatabase } from "../db/database";

export type InvalidationEvent = {
  type: "calendar.changed" | "task.changed" | "health.changed" | "finance.changed" | "integration.changed" | "auth.changed" | "overview.changed";
  entityId?: string;
  domain: "life" | "health" | "finance" | "integration" | "overview";
  version?: number;
  occurredAt: string;
};

export function emitInvalidation(input: Omit<InvalidationEvent, "occurredAt" | "version">, now = new Date()): InvalidationEvent {
  const timestamp = now.toISOString();
  const version = bumpSnapshotVersion(input.domain, timestamp);
  if (input.domain !== "overview") bumpSnapshotVersion("overview", timestamp);
  getDatabase().query(`
    INSERT INTO invalidation_events (type, entity_id, domain, version, occurred_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).run(input.type, input.entityId ?? null, input.domain, version, timestamp);
  return { ...input, version, occurredAt: timestamp };
}

export function listInvalidationEvents(afterId = 0): Array<InvalidationEvent & { id: number }> {
  return getDatabase().query<{
    id: number;
    type: InvalidationEvent["type"];
    entity_id: string | null;
    domain: InvalidationEvent["domain"];
    version: number | null;
    occurred_at: string;
  }, [number]>(`
    SELECT id, type, entity_id, domain, version, occurred_at
    FROM invalidation_events
    WHERE id > ?1
    ORDER BY id ASC
    LIMIT 100
  `).all(afterId).map((row) => ({
    id: row.id,
    type: row.type,
    entityId: row.entity_id ?? undefined,
    domain: row.domain,
    version: row.version ?? undefined,
    occurredAt: row.occurred_at,
  }));
}

function bumpSnapshotVersion(domain: InvalidationEvent["domain"], timestamp: string): number {
  getDatabase().query(`
    INSERT INTO snapshot_versions (domain, version, dirty, updated_at)
    VALUES (?1, 1, 1, ?2)
    ON CONFLICT(domain) DO UPDATE SET version = version + 1, dirty = 1, updated_at = excluded.updated_at
  `).run(domain, timestamp);
  return getDatabase().query<{ version: number }, [string]>("SELECT version FROM snapshot_versions WHERE domain = ?1").get(domain)?.version ?? 1;
}
