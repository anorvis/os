import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getDataRoot } from "../../paths";

let database: Database | undefined;

export function getDatabasePath(): string {
  return process.env.ANORVIS_DB_PATH ?? join(getDataRoot(), "anorvis.sqlite");
}

export function getDatabase(): Database {
  if (database) return database;
  const path = getDatabasePath();
  mkdirSync(dirname(path), { recursive: true });
  database = new Database(path, { create: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  runMigrations(database);
  return database;
}

export function resetDatabaseForTests(): void {
  database?.close();
  database = undefined;
}

function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const current = db.query<{ version: number }, []>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version ?? 0;
  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        location TEXT,
        description TEXT,
        tag TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        read_only INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calendar_events_start_at_idx ON calendar_events(start_at);
      CREATE INDEX IF NOT EXISTS calendar_events_end_at_idx ON calendar_events(end_at);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
    `);
  }
  if (current < 2) {
    db.exec(`
      UPDATE calendar_events SET source = 'local' WHERE source = 'anorvis';
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'));
    `);
  }
  if (current < 3) {
    addColumn(db, "calendar_events", "provider", "TEXT NOT NULL DEFAULT 'local'");
    addColumn(db, "calendar_events", "provider_event_id", "TEXT");
    addColumn(db, "calendar_events", "calendar_id", "TEXT");
    addColumn(db, "calendar_events", "all_day", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "calendar_events", "timezone", "TEXT");
    addColumn(db, "calendar_events", "source_hash", "TEXT");
    db.exec(`
      UPDATE calendar_events SET provider = source WHERE provider = 'local' AND source IN ('google-calendar', 'task');
      CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events(start_at, end_at);
      CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_provider_event_idx ON calendar_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS calendar_events_calendar_start_idx ON calendar_events(calendar_id, start_at);
      CREATE INDEX IF NOT EXISTS calendar_events_updated_at_idx ON calendar_events(updated_at DESC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (3, datetime('now'));
    `);
  }
  if (current < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT,
        due_at TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        duration_minutes INTEGER,
        links_json TEXT,
        multi_session INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_status_due_idx ON tasks(status, due_at);
      CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_id_idx ON tasks(source, source_id) WHERE source_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS task_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_sessions_task_id_idx ON task_sessions(task_id);
      CREATE INDEX IF NOT EXISTS task_sessions_range_idx ON task_sessions(start_at, end_at);
      CREATE INDEX IF NOT EXISTS task_sessions_status_start_idx ON task_sessions(status, start_at);
      INSERT INTO schema_migrations (version, applied_at) VALUES (4, datetime('now'));
    `);
  }
  if (current < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        meal_type TEXT NOT NULL,
        logged_at TEXT NOT NULL,
        calories REAL NOT NULL DEFAULT 0,
        protein_grams REAL NOT NULL DEFAULT 0,
        carbs_grams REAL NOT NULL DEFAULT 0,
        fat_grams REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'manual',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meals_logged_at_idx ON meals(logged_at DESC);
      CREATE INDEX IF NOT EXISTS meals_updated_at_idx ON meals(updated_at DESC);

      CREATE TABLE IF NOT EXISTS workouts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workouts_started_at_idx ON workouts(started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS workouts_source_id_idx ON workouts(source, source_id) WHERE source_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS workout_exercises (
        id TEXT PRIMARY KEY,
        workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        muscle_groups_json TEXT NOT NULL DEFAULT '[]',
        order_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS workout_exercises_workout_idx ON workout_exercises(workout_id, order_index);

      CREATE TABLE IF NOT EXISTS exercise_sets (
        id TEXT PRIMARY KEY,
        workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
        set_type TEXT NOT NULL DEFAULT 'normal',
        reps INTEGER,
        weight_kg REAL,
        duration_seconds INTEGER,
        distance_meters REAL,
        order_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS exercise_sets_exercise_idx ON exercise_sets(workout_exercise_id, order_index);

      CREATE TABLE IF NOT EXISTS macro_profiles (
        id TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 1,
        birthdate TEXT,
        height_cm REAL,
        weight_kg REAL,
        body_fat_percent REAL,
        sex TEXT,
        goal TEXT,
        training_days_per_week INTEGER,
        activity_level TEXT,
        target_calories REAL,
        protein_grams REAL,
        carbs_grams REAL,
        fat_grams REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS macro_profiles_active_idx ON macro_profiles(active);
      INSERT INTO schema_migrations (version, applied_at) VALUES (5, datetime('now'));
    `);
  }
  if (current < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS finance_accounts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        balance REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_source_id_idx ON finance_accounts(source, source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS finance_accounts_type_idx ON finance_accounts(type);
      CREATE INDEX IF NOT EXISTS finance_accounts_updated_at_idx ON finance_accounts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS finance_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES finance_accounts(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        fingerprint TEXT NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        posted_at TEXT NOT NULL,
        category_id TEXT,
        status TEXT NOT NULL DEFAULT 'posted',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS finance_transactions_posted_at_idx ON finance_transactions(posted_at DESC);
      CREATE INDEX IF NOT EXISTS finance_transactions_account_posted_idx ON finance_transactions(account_id, posted_at DESC);
      CREATE INDEX IF NOT EXISTS finance_transactions_category_posted_idx ON finance_transactions(category_id, posted_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS finance_transactions_source_id_idx ON finance_transactions(source, source_id) WHERE source_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS finance_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT NOT NULL,
        exclude_from_spending INTEGER NOT NULL DEFAULT 0,
        color TEXT
      );

      CREATE TABLE IF NOT EXISTS finance_positions (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES finance_accounts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_id TEXT,
        symbol TEXT NOT NULL,
        name TEXT,
        quantity REAL NOT NULL,
        market_value REAL,
        average_cost REAL,
        currency TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS finance_positions_account_idx ON finance_positions(account_id);
      CREATE INDEX IF NOT EXISTS finance_positions_symbol_idx ON finance_positions(symbol);
      CREATE UNIQUE INDEX IF NOT EXISTS finance_positions_source_id_idx ON finance_positions(source, source_id) WHERE source_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS finance_positions_account_symbol_idx ON finance_positions(source, account_id, symbol);

      CREATE TABLE IF NOT EXISTS finance_portfolio_history (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        equity REAL NOT NULL,
        cash REAL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source, date)
      );
      CREATE INDEX IF NOT EXISTS finance_portfolio_history_date_idx ON finance_portfolio_history(date DESC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (6, datetime('now'));
    `);
  }
  if (current < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_catalog (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        auth_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_connections (
        id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES integration_catalog(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'available',
        settings_json TEXT,
        secret_ref TEXT,
        connected_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS integration_connections_integration_idx ON integration_connections(integration_id);
      CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_integration_unique_idx ON integration_connections(integration_id);
      CREATE INDEX IF NOT EXISTS integration_connections_status_idx ON integration_connections(status);
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, datetime('now'));
    `);
  }
  if (current < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS overview_snapshot (scope_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, source_version INTEGER NOT NULL, computed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS life_snapshot (scope_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, source_version INTEGER NOT NULL, computed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_dashboard_snapshot (scope_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, source_version INTEGER NOT NULL, computed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS finance_dashboard_snapshot (scope_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, source_version INTEGER NOT NULL, computed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_versions (domain TEXT PRIMARY KEY, version INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invalidation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_id TEXT, domain TEXT NOT NULL, version INTEGER, occurred_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS invalidation_events_id_idx ON invalidation_events(id);
      INSERT INTO schema_migrations (version, applied_at) VALUES (8, datetime('now'));
    `);
  }
  if (current < 9) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_integration_unique_idx ON integration_connections(integration_id);
      INSERT INTO schema_migrations (version, applied_at) VALUES (9, datetime('now'));
    `);
  }
  if (current < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secret_records (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        nonce TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (10, datetime('now'));
    `);
  }
  if (current < 11) {
    addColumn(db, "tasks", "links_json", "TEXT");
    addColumn(db, "tasks", "multi_session", "INTEGER NOT NULL DEFAULT 0");
    db.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (11, datetime('now'))");
  }
  seedIntegrationCatalog(db);
}

function addColumn(db: Database, table: string, column: string, definition: string): void {
  const exists = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedIntegrationCatalog(db: Database): void {
  const integrations = [
    ["google-calendar", "Google Calendar", "life", "Calendar provider for schedule context.", JSON.stringify(["calendar.read", "calendar.sync"]), "oauth2"],
    ["google-tasks", "Google Tasks", "productivity", "Task provider for priority queues.", JSON.stringify(["tasks.read", "tasks.sync"]), "oauth2"],
    ["spotify", "Spotify", "life", "Now-playing context for focus sessions.", JSON.stringify(["music.read"]), "oauth2"],
    ["hevy", "Hevy", "health", "Workout sync for health dashboards.", JSON.stringify(["workouts.sync"]), "token"],
  ];
  const insert = db.query("INSERT OR IGNORE INTO integration_catalog (id, display_name, category, description, capabilities_json, auth_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)");
  for (const integration of integrations) insert.run(...integration);
}
