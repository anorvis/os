import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getDataRoot, getHomeDir } from "../../paths";

let database: Database | undefined;

export function getDatabasePath(): string {
  if (process.env.ANORVIS_DB_PATH) return process.env.ANORVIS_DB_PATH;
  const canonicalPath = join(getDataRoot(), "anorvis.sqlite");
  const legacyPath = join(getHomeDir(), ".anorvis", "db", "anorvis.sqlite");
  return existsSync(canonicalPath)
    ? canonicalPath
    : existsSync(legacyPath)
      ? legacyPath
      : canonicalPath;
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

  const current =
    db
      .query<{ version: number }, []>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get()?.version ?? 0;
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
        provider TEXT NOT NULL DEFAULT 'local',
        provider_event_id TEXT,
        calendar_id TEXT,
        all_day INTEGER NOT NULL DEFAULT 0,
        timezone TEXT,
        source_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calendar_events_start_at_idx ON calendar_events(start_at);
      CREATE INDEX IF NOT EXISTS calendar_events_end_at_idx ON calendar_events(end_at);
      CREATE INDEX IF NOT EXISTS calendar_events_range_idx ON calendar_events(start_at, end_at);
      CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_provider_event_idx ON calendar_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS calendar_events_calendar_start_idx ON calendar_events(calendar_id, start_at);
      CREATE INDEX IF NOT EXISTS calendar_events_updated_at_idx ON calendar_events(updated_at DESC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
    `);
  }
  if (current < 2) {
    db.exec(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'))",
    );
  }
  if (current < 3) {
    db.exec(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (3, datetime('now'))",
    );
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
    `);
    ensureTasksColumns(db);
    db.exec(`
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
    `);
    ensureTaskSessionsColumns(db);
    db.exec(`
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
    db.exec(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (11, datetime('now'))",
    );
  }
  if (current < 12) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_definitions (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES provider_definitions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'available',
        settings_json TEXT NOT NULL DEFAULT '{}',
        secret_refs_json TEXT NOT NULL DEFAULT '{}',
        connected_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id)
      );
      INSERT INTO schema_migrations (version, applied_at) VALUES (12, datetime('now'));
    `);
  }
  if (current < 13) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        source_url TEXT,
        image_url TEXT,
        youtube_url TEXT,
        category TEXT,
        area TEXT,
        calories REAL NOT NULL DEFAULT 0,
        protein_grams REAL NOT NULL DEFAULT 0,
        carbs_grams REAL NOT NULL DEFAULT 0,
        fat_grams REAL NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS recipes_source_id_idx ON recipes(source, source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS recipes_updated_at_idx ON recipes(updated_at DESC);
      CREATE INDEX IF NOT EXISTS recipes_favorite_idx ON recipes(is_favorite);
      CREATE TABLE IF NOT EXISTS recipe_ingredients (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        quantity TEXT,
        order_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe_idx ON recipe_ingredients(recipe_id, order_index);
      CREATE TABLE IF NOT EXISTS recipe_instructions (
        id TEXT PRIMARY KEY,
        recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recipe_instructions_recipe_idx ON recipe_instructions(recipe_id, step_index);
      INSERT INTO schema_migrations (version, applied_at) VALUES (13, datetime('now'));
    `);
  }
  if (current < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS life_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        color TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS life_tags_normalized_name_idx ON life_tags(normalized_name);
      CREATE INDEX IF NOT EXISTS life_tags_updated_at_idx ON life_tags(updated_at DESC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (14, datetime('now'));
    `);
  }
  if (current < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS body_measurements (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        weight_kg REAL,
        lean_mass_kg REAL,
        fat_percent REAL,
        neck_cm REAL,
        shoulder_cm REAL,
        chest_cm REAL,
        left_bicep_cm REAL,
        right_bicep_cm REAL,
        left_forearm_cm REAL,
        right_forearm_cm REAL,
        abdomen_cm REAL,
        waist_cm REAL,
        hips_cm REAL,
        left_thigh_cm REAL,
        right_thigh_cm REAL,
        left_calf_cm REAL,
        right_calf_cm REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, source_id)
      );
      CREATE INDEX IF NOT EXISTS body_measurements_recorded_at_idx ON body_measurements(recorded_at ASC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (15, datetime('now'));
    `);
  }
  if (current < 16) {
    db.exec(`
      ALTER TABLE life_tags ADD COLUMN system_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS life_tags_system_key_idx ON life_tags(system_key) WHERE system_key IS NOT NULL;
      INSERT INTO life_tags (id, name, normalized_name, color, hidden, created_at, updated_at, system_key)
      VALUES ('system:hevy', 'Hevy', 'hevy', '#ef4444', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'hevy')
      ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name, hidden = 0, updated_at = excluded.updated_at, system_key = excluded.system_key;
      INSERT INTO life_tags (id, name, normalized_name, color, hidden, created_at, updated_at, system_key)
      VALUES ('system:google-calendar', 'Google Calendar', 'google calendar', '#4285f4', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'google-calendar')
      ON CONFLICT(normalized_name) DO UPDATE SET name = excluded.name, hidden = 0, updated_at = excluded.updated_at, system_key = excluded.system_key;
      INSERT INTO schema_migrations (version, applied_at) VALUES (16, datetime('now'));
    `);
  }
  if (current < 17) {
    addColumn(db, "finance_accounts", "source_variant", "TEXT");
    addColumn(db, "finance_accounts", "import_id", "TEXT");
    addColumn(db, "finance_accounts", "institution", "TEXT");
    addColumn(db, "finance_accounts", "mask", "TEXT");
    addColumn(
      db,
      "finance_accounts",
      "status",
      "TEXT NOT NULL DEFAULT 'active'",
    );
    addColumn(db, "finance_accounts", "observed_at", "TEXT");
    addColumn(db, "finance_transactions", "source_variant", "TEXT");
    addColumn(db, "finance_transactions", "import_id", "TEXT");
    addColumn(db, "finance_positions", "source_variant", "TEXT");
    addColumn(db, "finance_positions", "import_id", "TEXT");
    addColumn(db, "finance_positions", "observed_at", "TEXT");
    // Collapse legacy provider-scoped sources (e.g. 'csv:chase_cc') to the
    // canonical provider ('csv') while preserving the bank format in
    // source_variant. Lossless: only relabels, never deletes rows. Idempotent:
    // once collapsed the rows no longer match the LIKE 'csv:%' predicate.
    db.exec(`
      UPDATE finance_accounts SET source_variant = COALESCE(source_variant, substr(source, 5)), source = 'csv' WHERE source LIKE 'csv:%';
      UPDATE finance_transactions SET source_variant = COALESCE(source_variant, substr(source, 5)), source = 'csv' WHERE source LIKE 'csv:%';
      UPDATE finance_positions SET source_variant = COALESCE(source_variant, substr(source, 5)), source = 'csv' WHERE source LIKE 'csv:%';

      CREATE TABLE IF NOT EXISTS finance_imports (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_variant TEXT,
        account_id TEXT REFERENCES finance_accounts(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        imported_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS finance_imports_source_idx ON finance_imports(source, source_variant);
      CREATE INDEX IF NOT EXISTS finance_imports_status_idx ON finance_imports(status);
      CREATE INDEX IF NOT EXISTS finance_imports_created_at_idx ON finance_imports(created_at DESC);

      CREATE TABLE IF NOT EXISTS finance_balances (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
        currency TEXT NOT NULL,
        cash REAL,
        buying_power REAL,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_variant TEXT,
        import_id TEXT REFERENCES finance_imports(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS finance_balances_account_currency_idx ON finance_balances(account_id, currency);
      CREATE INDEX IF NOT EXISTS finance_balances_currency_idx ON finance_balances(currency);
      CREATE INDEX IF NOT EXISTS finance_balances_observed_at_idx ON finance_balances(observed_at DESC);

      CREATE TABLE IF NOT EXISTS finance_activities (
        id TEXT PRIMARY KEY,
        account_id TEXT REFERENCES finance_accounts(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        source_variant TEXT,
        import_id TEXT REFERENCES finance_imports(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        description TEXT,
        amount REAL,
        currency TEXT NOT NULL,
        symbol TEXT,
        quantity REAL,
        price REAL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'posted',
        occurred_at TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS finance_activities_account_occurred_idx ON finance_activities(account_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS finance_activities_occurred_at_idx ON finance_activities(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS finance_activities_type_idx ON finance_activities(type);
      CREATE UNIQUE INDEX IF NOT EXISTS finance_activities_source_id_idx ON finance_activities(source, source_id) WHERE source_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_source_variant_name_idx ON finance_accounts(source, source_variant, name) WHERE source = 'csv';
      CREATE INDEX IF NOT EXISTS finance_accounts_import_idx ON finance_accounts(import_id);
      CREATE INDEX IF NOT EXISTS finance_transactions_import_idx ON finance_transactions(import_id);
      CREATE INDEX IF NOT EXISTS finance_positions_import_idx ON finance_positions(import_id);

      INSERT INTO schema_migrations (version, applied_at) VALUES (17, datetime('now'));
    `);
  }
  if (current < 18) {
    db.exec(`
      DROP INDEX IF EXISTS finance_accounts_source_variant_name_idx;
      CREATE UNIQUE INDEX finance_accounts_source_variant_name_currency_idx ON finance_accounts(source, source_variant, name, currency) WHERE source = 'csv';
      INSERT INTO schema_migrations (version, applied_at) VALUES (18, datetime('now'));
    `);
  }
  if (current < 19) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS finance_account_value_history (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_variant TEXT,
        date TEXT NOT NULL,
        equity REAL NOT NULL,
        cash REAL,
        currency TEXT NOT NULL,
        import_id TEXT REFERENCES finance_imports(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, account_id, date)
      );
      CREATE INDEX IF NOT EXISTS finance_account_value_history_date_idx ON finance_account_value_history(date ASC);
      CREATE INDEX IF NOT EXISTS finance_account_value_history_account_idx ON finance_account_value_history(account_id, date ASC);

      CREATE TABLE IF NOT EXISTS finance_account_return_rates (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        source_variant TEXT,
        timeframe TEXT NOT NULL,
        return_percent REAL NOT NULL,
        as_of TEXT,
        import_id TEXT REFERENCES finance_imports(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source, account_id, timeframe)
      );
      CREATE INDEX IF NOT EXISTS finance_account_return_rates_account_idx ON finance_account_return_rates(account_id, timeframe);
      CREATE INDEX IF NOT EXISTS finance_account_return_rates_observed_idx ON finance_account_return_rates(observed_at DESC);

      INSERT INTO schema_migrations (version, applied_at) VALUES (19, datetime('now'));
    `);
  }
  if (current < 20) {
    addColumn(db, "finance_transactions", "dedupe_key", "TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS finance_account_links (
        account_id TEXT PRIMARY KEY REFERENCES finance_accounts(id) ON DELETE CASCADE,
        canonical_account_id TEXT NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
        method TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (account_id <> canonical_account_id)
      );
      CREATE INDEX IF NOT EXISTS finance_account_links_canonical_idx ON finance_account_links(canonical_account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS finance_transactions_dedupe_key_idx ON finance_transactions(dedupe_key) WHERE dedupe_key IS NOT NULL;
      INSERT INTO schema_migrations (version, applied_at) VALUES (20, datetime('now'));
    `);
  }
  if (current < 21) {
    db.exec(`
      UPDATE finance_accounts
      SET type = 'checking', updated_at = datetime('now')
      WHERE source = 'snaptrade'
        AND type = 'investment'
        AND (
          upper(name) LIKE '% MSB%'
          OR upper(name) LIKE '% CHEQUING%'
          OR upper(name) LIKE '% CHECKING%'
        );

      UPDATE finance_accounts
      SET type = 'savings', updated_at = datetime('now')
      WHERE source = 'snaptrade'
        AND type = 'investment'
        AND (upper(name) LIKE '% SAVINGS%' OR upper(name) LIKE '% HISA%');

      INSERT INTO finance_categories (id, name, group_name, exclude_from_spending, color)
      VALUES ('card-spend', 'card spend', 'spending', 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_name = excluded.group_name,
        exclude_from_spending = excluded.exclude_from_spending;

      INSERT OR IGNORE INTO finance_transactions (
        id, account_id, source, source_id, fingerprint, description, amount,
        currency, posted_at, category_id, status, notes, created_at, updated_at,
        source_variant, import_id, dedupe_key
      )
      SELECT
        'promoted:' || activity.id,
        activity.account_id,
        activity.source,
        activity.source_id,
        activity.fingerprint,
        COALESCE(NULLIF(trim(activity.description), ''), 'Card purchase'),
        -activity.amount,
        upper(activity.currency),
        activity.occurred_at,
        'card-spend',
        'posted',
        NULL,
        activity.created_at,
        datetime('now'),
        activity.source_variant,
        activity.import_id,
        NULL
      FROM finance_activities AS activity
      JOIN finance_accounts AS account ON account.id = activity.account_id
      WHERE activity.source = 'snaptrade'
        AND lower(activity.type) = 'spend'
        AND account.type IN ('checking', 'savings')
        AND activity.amount IS NOT NULL
        AND activity.amount != 0
        AND activity.symbol IS NULL
        AND activity.quantity IS NULL
        AND activity.price IS NULL;

      DELETE FROM finance_activities
      WHERE source = 'snaptrade'
        AND lower(type) = 'spend'
        AND EXISTS (
          SELECT 1
          FROM finance_transactions AS transaction_record
          WHERE transaction_record.source = finance_activities.source
            AND transaction_record.fingerprint = finance_activities.fingerprint
        );

      INSERT INTO schema_migrations (version, applied_at) VALUES (21, datetime('now'));
    `);
  }
  if (current < 22) {
    db.exec(`
      INSERT INTO finance_categories (id, name, group_name, exclude_from_spending, color)
      VALUES ('card-spend', 'card spend', 'spending', 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_name = excluded.group_name,
        exclude_from_spending = excluded.exclude_from_spending;

      INSERT OR IGNORE INTO finance_transactions (
        id, account_id, source, source_id, fingerprint, description, amount,
        currency, posted_at, category_id, status, notes, created_at, updated_at,
        source_variant, import_id, dedupe_key
      )
      SELECT
        'promoted:' || activity.id,
        activity.account_id,
        activity.source,
        activity.source_id,
        activity.fingerprint,
        CASE
          WHEN NULLIF(trim(COALESCE(activity.description, '')), '') IS NOT NULL
           AND lower(trim(activity.description)) <> 'spend'
            THEN trim(activity.description)
          WHEN activity.amount < 0 THEN 'Card refund'
          ELSE 'Card purchase'
        END,
        -activity.amount,
        upper(activity.currency),
        activity.occurred_at,
        'card-spend',
        'posted',
        NULL,
        activity.created_at,
        datetime('now'),
        activity.source_variant,
        activity.import_id,
        NULL
      FROM finance_activities AS activity
      JOIN finance_accounts AS account ON account.id = activity.account_id
      WHERE activity.source = 'snaptrade'
        AND lower(activity.type) = 'spend'
        AND account.type IN ('checking', 'savings')
        AND activity.amount IS NOT NULL
        AND activity.amount != 0
        AND activity.symbol IS NULL
        AND (activity.quantity IS NULL OR activity.quantity = 0)
        AND (activity.price IS NULL OR activity.price = 0);

      UPDATE finance_transactions
      SET
        description = (
          SELECT CASE
            WHEN NULLIF(trim(COALESCE(activity.description, '')), '') IS NOT NULL
             AND lower(trim(activity.description)) <> 'spend'
              THEN trim(activity.description)
            WHEN activity.amount < 0 THEN 'Card refund'
            ELSE 'Card purchase'
          END
          FROM finance_activities AS activity
          WHERE activity.source = 'snaptrade'
            AND lower(activity.type) = 'spend'
            AND activity.amount IS NOT NULL
            AND activity.amount != 0
            AND activity.symbol IS NULL
            AND (activity.quantity IS NULL OR activity.quantity = 0)
            AND (activity.price IS NULL OR activity.price = 0)
            AND finance_transactions.id = 'promoted:' || activity.id
            AND finance_transactions.source = activity.source
            AND finance_transactions.fingerprint = activity.fingerprint
        ),
        amount = (
          SELECT -activity.amount
          FROM finance_activities AS activity
          WHERE activity.source = 'snaptrade'
            AND lower(activity.type) = 'spend'
            AND activity.amount IS NOT NULL
            AND activity.amount != 0
            AND activity.symbol IS NULL
            AND (activity.quantity IS NULL OR activity.quantity = 0)
            AND (activity.price IS NULL OR activity.price = 0)
            AND finance_transactions.id = 'promoted:' || activity.id
            AND finance_transactions.source = activity.source
            AND finance_transactions.fingerprint = activity.fingerprint
        ),
        category_id = 'card-spend',
        updated_at = datetime('now')
      WHERE EXISTS (
        SELECT 1
        FROM finance_activities AS activity
        JOIN finance_accounts AS account ON account.id = activity.account_id
        WHERE activity.source = 'snaptrade'
          AND lower(activity.type) = 'spend'
          AND account.type IN ('checking', 'savings')
          AND activity.amount IS NOT NULL
          AND activity.amount != 0
          AND activity.symbol IS NULL
          AND (activity.quantity IS NULL OR activity.quantity = 0)
          AND (activity.price IS NULL OR activity.price = 0)
          AND finance_transactions.id = 'promoted:' || activity.id
          AND finance_transactions.source = activity.source
          AND finance_transactions.fingerprint = activity.fingerprint
      );

      DELETE FROM finance_activities
      WHERE source = 'snaptrade'
        AND lower(type) = 'spend'
        AND symbol IS NULL
        AND (quantity IS NULL OR quantity = 0)
        AND (price IS NULL OR price = 0)
        AND EXISTS (
          SELECT 1
          FROM finance_transactions AS transaction_record
          WHERE transaction_record.source = finance_activities.source
            AND transaction_record.fingerprint = finance_activities.fingerprint
            AND transaction_record.id = 'promoted:' || finance_activities.id
        );

      CREATE TEMP TABLE IF NOT EXISTS migration_22_csv_orphan_accounts (
        account_id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL
      );
      DELETE FROM migration_22_csv_orphan_accounts;

      INSERT OR IGNORE INTO migration_22_csv_orphan_accounts (account_id, import_id)
      SELECT account.id, receipt.id
      FROM finance_accounts AS account
      JOIN finance_imports AS receipt
        ON receipt.id = account.import_id
       AND receipt.account_id = account.id
       AND receipt.created_at = account.created_at
      WHERE account.source = 'csv'
        AND receipt.source = 'csv'
        AND receipt.status = 'undone'
        AND NOT EXISTS (
          SELECT 1 FROM finance_imports AS live_receipt
          WHERE live_receipt.account_id = account.id
            AND live_receipt.id <> receipt.id
            AND live_receipt.status <> 'undone'
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_transactions AS transaction_record
          WHERE transaction_record.account_id = account.id
            AND COALESCE(transaction_record.import_id, '') <> receipt.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_positions AS position_record
          WHERE position_record.account_id = account.id
            AND COALESCE(position_record.import_id, '') <> receipt.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_activities AS activity_record
          WHERE activity_record.account_id = account.id
            AND COALESCE(activity_record.import_id, '') <> receipt.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_account_links AS link_record
          WHERE link_record.account_id = account.id
             OR link_record.canonical_account_id = account.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_account_return_rates AS return_record
          WHERE return_record.account_id = account.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_balances AS balance_record
          WHERE balance_record.account_id = account.id
            AND COALESCE(balance_record.import_id, '') <> receipt.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM finance_account_value_history AS history_record
          WHERE history_record.account_id = account.id
            AND COALESCE(history_record.import_id, '') <> receipt.id
        );

      DELETE FROM finance_balances
      WHERE EXISTS (
        SELECT 1 FROM migration_22_csv_orphan_accounts AS orphan
        WHERE orphan.account_id = finance_balances.account_id
          AND orphan.import_id = finance_balances.import_id
      );

      DELETE FROM finance_account_value_history
      WHERE EXISTS (
        SELECT 1 FROM migration_22_csv_orphan_accounts AS orphan
        WHERE orphan.account_id = finance_account_value_history.account_id
          AND orphan.import_id = finance_account_value_history.import_id
      );

      DELETE FROM finance_accounts
      WHERE EXISTS (
        SELECT 1 FROM migration_22_csv_orphan_accounts AS orphan
        WHERE orphan.account_id = finance_accounts.id
      );

      DROP TABLE migration_22_csv_orphan_accounts;

      INSERT INTO schema_migrations (version, applied_at) VALUES (22, datetime('now'));
    `);
  }
  ensureTasksColumns(db);
  ensureTaskSessionsColumns(db);
  ensureInvalidationTables(db);

  seedIntegrationCatalog(db);
  seedProviderDefinitions(db);
}

type TableColumn = {
  name: string;
  notnull: number;
};

function tableColumns(db: Database, table: string): TableColumn[] {
  return db.query<TableColumn, []>(`PRAGMA table_info(${table})`).all();
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return tableColumns(db, table).some((row) => row.name === column);
}

function addColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!hasColumn(db, table, column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureTasksColumns(db: Database): void {
  const columns = tableColumns(db, "tasks");
  if (columns.length === 0) return;

  addColumn(db, "tasks", "due_at", "TEXT");
  addColumn(db, "tasks", "source", "TEXT NOT NULL DEFAULT 'manual'");
  addColumn(db, "tasks", "source_id", "TEXT");
  addColumn(db, "tasks", "duration_minutes", "INTEGER");
  addColumn(db, "tasks", "links_json", "TEXT");
  addColumn(db, "tasks", "multi_session", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "tasks", "completed_at", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS tasks_status_due_idx ON tasks(status, due_at);
    CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks(updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_id_idx ON tasks(source, source_id) WHERE source_id IS NOT NULL;
  `);
}

function ensureTaskSessionsColumns(db: Database): void {
  const columns = tableColumns(db, "task_sessions");
  if (columns.length === 0) return;

  addColumn(
    db,
    "task_sessions",
    "start_at",
    "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  );
  addColumn(
    db,
    "task_sessions",
    "end_at",
    "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
  );
  addColumn(db, "task_sessions", "status", "TEXT NOT NULL DEFAULT 'planned'");
  addColumn(db, "task_sessions", "source", "TEXT NOT NULL DEFAULT 'manual'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS task_sessions_task_id_idx ON task_sessions(task_id);
    CREATE INDEX IF NOT EXISTS task_sessions_range_idx ON task_sessions(start_at, end_at);
    CREATE INDEX IF NOT EXISTS task_sessions_status_start_idx ON task_sessions(status, start_at);
  `);
}

function ensureInvalidationTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_versions (domain TEXT PRIMARY KEY, version INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invalidation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_id TEXT, domain TEXT NOT NULL, version INTEGER, occurred_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS invalidation_events_id_idx ON invalidation_events(id);
  `);
}

function seedIntegrationCatalog(db: Database): void {
  const integrations = [
    [
      "google",
      "Google Workspace",
      "life",
      "Calendar, Gmail, and Drive context for scheduling and retrieval.",
      JSON.stringify(["calendar.read", "calendar.sync"]),
      "oauth2",
    ],
    [
      "google-calendar",
      "Google Calendar",
      "life",
      "Calendar provider for schedule context.",
      JSON.stringify(["calendar.read", "calendar.sync"]),
      "oauth2",
    ],
    [
      "google-tasks",
      "Google Tasks",
      "productivity",
      "Task provider for priority queues.",
      JSON.stringify(["tasks.read", "tasks.sync"]),
      "oauth2",
    ],
    [
      "spotify",
      "Spotify",
      "life",
      "Now-playing context for focus sessions.",
      JSON.stringify(["music.read"]),
      "oauth2",
    ],
    [
      "hevy",
      "Hevy",
      "health",
      "Workout sync for health dashboards.",
      JSON.stringify(["workouts.sync"]),
      "token",
    ],
    [
      "snaptrade",
      "SnapTrade",
      "finance",
      "Read-only brokerage accounts, balances, positions, and activity sync.",
      JSON.stringify([
        "accounts.read",
        "balances.read",
        "positions.read",
        "activities.read",
        "transactions.read",
      ]),
      "token",
    ],
  ];
  const insert = db.query(
    "INSERT OR IGNORE INTO integration_catalog (id, display_name, category, description, capabilities_json, auth_type) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  for (const integration of integrations) insert.run(...integration);
}

function seedProviderDefinitions(db: Database): void {
  const timestamp = new Date().toISOString();
  const providers = [
    [
      "google",
      "Google Workspace",
      "life",
      JSON.stringify(["calendar.read", "calendar.sync"]),
      "oauth2",
    ],
    [
      "google-calendar",
      "Google Calendar",
      "life",
      JSON.stringify(["calendar.read", "calendar.sync"]),
      "oauth2",
    ],
    [
      "google-tasks",
      "Google Tasks",
      "productivity",
      JSON.stringify(["tasks.read", "tasks.sync"]),
      "oauth2",
    ],
    ["spotify", "Spotify", "life", JSON.stringify(["music.read"]), "oauth2"],
    ["hevy", "Hevy", "health", JSON.stringify(["workouts.sync"]), "token"],
    [
      "snaptrade",
      "SnapTrade",
      "finance",
      JSON.stringify([
        "accounts.read",
        "balances.read",
        "positions.read",
        "activities.read",
        "transactions.read",
      ]),
      "token",
    ],
  ];
  const insert = db.query(
    "INSERT OR IGNORE INTO provider_definitions (id, display_name, category, capabilities_json, auth_type, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
  );
  for (const provider of providers) insert.run(...provider, timestamp);
}
