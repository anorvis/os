import { randomUUID } from "node:crypto";
import { getDatabase } from "../../core/db/database";
import { decodeUnknownResult } from "../../core/effect/schema";
import { LifeTagCreateBodySchema, LifeTagUpdateBodySchema } from "./schema";

export type LifeTag = {
  id: string;
  name: string;
  color: string | null;
  hidden: boolean;
  system: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LifeTagCreateInput = {
  name: string;
  color?: string | null;
};

export type LifeTagPatch = {
  name?: string;
  color?: string | null;
  hidden?: boolean;
};

type LifeTagRow = {
  id: string;
  name: string;
  normalized_name: string;
  color: string | null;
  system_key: string | null;
  hidden: number;
  created_at: string;
  updated_at: string;
};

export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

export function listLifeTags(): LifeTag[] {
  const rows = getDatabase()
    .query<LifeTagRow, []>(
      `
    SELECT id, name, normalized_name, color, hidden, system_key, created_at, updated_at
    FROM life_tags
    ORDER BY created_at ASC, name ASC
  `,
    )
    .all();
  return rows.map(rowToLifeTag);
}

export function getLifeTag(id: string): LifeTag | null {
  const row = getDatabase()
    .query<LifeTagRow, [string]>(
      `
    SELECT id, name, normalized_name, color, hidden, system_key, created_at, updated_at
    FROM life_tags
    WHERE id = ?1
  `,
    )
    .get(id);
  return row ? rowToLifeTag(row) : null;
}

function getLifeTagByNormalized(normalized: string): LifeTag | null {
  const row = getDatabase()
    .query<LifeTagRow, [string]>(
      `
    SELECT id, name, normalized_name, color, hidden, system_key, created_at, updated_at
    FROM life_tags
    WHERE normalized_name = ?1
  `,
    )
    .get(normalized);
  return row ? rowToLifeTag(row) : null;
}

// Upsert by normalized name: create when absent, otherwise refresh the display
// name, apply an explicit color when supplied, and unhide the record.
export function upsertLifeTag(
  input: LifeTagCreateInput,
  now = new Date(),
): LifeTag {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const normalized = normalizeTagName(name);
  const color = cleanColor(input.color);
  const timestamp = now.toISOString();
  const existing = getLifeTagByNormalized(normalized);
  if (existing) {
    if (existing.system) {
      getDatabase()
        .query(
          `
        UPDATE life_tags
        SET color = COALESCE(?2, color), updated_at = ?3
        WHERE id = ?1
      `,
        )
        .run(existing.id, color, timestamp);
    } else {
      getDatabase()
        .query(
          `
        UPDATE life_tags
        SET name = ?2, color = COALESCE(?3, color), hidden = 0, updated_at = ?4
        WHERE id = ?1
      `,
        )
        .run(existing.id, name, color, timestamp);
    }
    const updated = getLifeTag(existing.id);
    if (!updated) throw new Error("life tag could not be read");
    return updated;
  }
  const id = randomUUID();
  getDatabase()
    .query(
      `
    INSERT INTO life_tags (id, name, normalized_name, color, hidden, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
  `,
    )
    .run(id, name, normalized, color, timestamp);
  const created = getLifeTag(id);
  if (!created) throw new Error("life tag could not be read");
  return created;
}

// Update name/color/hidden on an existing record, preserving the stable id so
// a rename keeps the same catalog identity (and its persisted color).
export function updateLifeTag(
  id: string,
  patch: LifeTagPatch,
  now = new Date(),
): LifeTag | null {
  const existing = getLifeTag(id);
  if (!existing) return null;
  if (
    existing.system &&
    (patch.name !== undefined || patch.hidden !== undefined)
  ) {
    throw new Error("automatic tag names and visibility cannot be changed");
  }
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!name) throw new Error("name is required");
  const normalized = normalizeTagName(name);
  const collision = getLifeTagByNormalized(normalized);
  if (collision && collision.id !== id)
    throw new Error("a tag with that name already exists");
  const color =
    patch.color !== undefined ? cleanColor(patch.color) : existing.color;
  const hidden = patch.hidden !== undefined ? patch.hidden : existing.hidden;
  getDatabase()
    .query(
      `
    UPDATE life_tags
    SET name = ?2, normalized_name = ?3, color = ?4, hidden = ?5, updated_at = ?6
    WHERE id = ?1
  `,
    )
    .run(id, name, normalized, color, hidden ? 1 : 0, now.toISOString());
  return getLifeTag(id);
}

// Durably hide rather than delete so an in-range calendar event carrying this
// tag name cannot immediately recreate it on the next range read.
export function hideLifeTag(id: string, now = new Date()): LifeTag | null {
  const existing = getLifeTag(id);
  if (!existing) return null;
  if (existing.system) throw new Error("automatic tags cannot be removed");
  getDatabase()
    .query(
      `
    UPDATE life_tags
    SET hidden = 1, updated_at = ?2
    WHERE id = ?1
  `,
    )
    .run(id, now.toISOString());
  return getLifeTag(id);
}

export function parseLifeTagCreate(value: unknown): LifeTagCreateInput | null {
  const decoded = decodeUnknownResult(LifeTagCreateBodySchema, value);
  if (!decoded.ok) return null;
  const name = decoded.value.name.trim();
  if (!name) return null;
  return {
    name,
    color:
      typeof decoded.value.color === "string" ? decoded.value.color : undefined,
  };
}

export function parseLifeTagPatch(value: unknown): LifeTagPatch | null {
  const decoded = decodeUnknownResult(LifeTagUpdateBodySchema, value);
  if (!decoded.ok) return null;
  const raw = decoded.value;
  const patch: LifeTagPatch = {};
  if (typeof raw.name === "string") patch.name = raw.name;
  if (raw.color !== undefined)
    patch.color = typeof raw.color === "string" ? raw.color : null;
  if (typeof raw.hidden === "boolean") patch.hidden = raw.hidden;
  return patch;
}

function cleanColor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const clean = value.trim();
  return clean ? clean : null;
}

function rowToLifeTag(row: LifeTagRow): LifeTag {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    hidden: row.hidden === 1,
    system: row.system_key !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
