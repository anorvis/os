import { getDatabase } from "../db/database";

export type SnapshotTable = "overview_snapshot" | "life_snapshot" | "health_dashboard_snapshot" | "finance_dashboard_snapshot";
export type SnapshotDomain = "overview" | "life" | "health" | "finance" | "integration";

export function readSnapshot<T>(table: SnapshotTable, domain: SnapshotDomain, compute: () => T, now = new Date()): T {
  const version = getSnapshotVersion(domain);
  const row = getDatabase().query<{ snapshot_json: string; source_version: number }, [string]>(`SELECT snapshot_json, source_version FROM ${table} WHERE scope_id = ?1`).get("local");
  if (row && row.source_version === version && !isSnapshotDirty(domain)) {
    const parsed = JSON.parse(row.snapshot_json) as T;
    return parsed;
  }
  const snapshot = compute();
  getDatabase().query(`
    INSERT INTO ${table} (scope_id, snapshot_json, source_version, computed_at)
    VALUES ('local', ?1, ?2, ?3)
    ON CONFLICT(scope_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, source_version = excluded.source_version, computed_at = excluded.computed_at
  `).run(JSON.stringify(snapshot), version, now.toISOString());
  markSnapshotClean(domain, now);
  return snapshot;
}

function getSnapshotVersion(domain: SnapshotDomain): number {
  return getDatabase().query<{ version: number }, [string]>("SELECT version FROM snapshot_versions WHERE domain = ?1").get(domain)?.version ?? 0;
}

function isSnapshotDirty(domain: SnapshotDomain): boolean {
  return (getDatabase().query<{ dirty: number }, [string]>("SELECT dirty FROM snapshot_versions WHERE domain = ?1").get(domain)?.dirty ?? 0) === 1;
}

function markSnapshotClean(domain: SnapshotDomain, now: Date): void {
  getDatabase().query(`
    INSERT INTO snapshot_versions (domain, version, dirty, updated_at)
    VALUES (?1, 0, 0, ?2)
    ON CONFLICT(domain) DO UPDATE SET dirty = 0, updated_at = excluded.updated_at
  `).run(domain, now.toISOString());
}
