import { randomUUID } from "node:crypto";
import { getDatabase } from "../../core/db/database";
import { decodeUnknownResult } from "../../core/effect/schema";
import {
  isRecord,
  nullableStringValue,
  numberValue,
  stringField,
  stringValue,
} from "./data";
import { RecipeInputBodySchema } from "./schema";

export type RecipeIngredient = {
  id: string;
  name: string;
  quantity: string | null;
};

export type Recipe = {
  id: string;
  title: string;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  youtubeUrl: string | null;
  category: string | null;
  area: string | null;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  isFavorite: boolean;
  notes: string | null;
  ingredients: RecipeIngredient[];
  instructions: string[];
  createdAt: string;
  updatedAt: string;
};

export type RecipeInput = {
  title: string;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  youtubeUrl: string | null;
  category: string | null;
  area: string | null;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  isFavorite: boolean;
  notes: string | null;
  ingredients: Array<{ name: string; quantity: string | null }>;
  instructions: string[];
};

type RecipeRow = {
  id: string;
  title: string;
  source: string;
  source_id: string | null;
  source_url: string | null;
  image_url: string | null;
  youtube_url: string | null;
  category: string | null;
  area: string | null;
  calories: number;
  protein_grams: number;
  carbs_grams: number;
  fat_grams: number;
  is_favorite: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const RECIPE_COLUMNS =
  "id, title, source, source_id, source_url, image_url, youtube_url, category, area, calories, protein_grams, carbs_grams, fat_grams, is_favorite, notes, created_at, updated_at";

export function parseRecipeInput(value: unknown): RecipeInput | null {
  const decoded = decodeUnknownResult(RecipeInputBodySchema, value);
  if (!decoded.ok) return null;
  const input = decoded.value;
  const title = input.title.trim();
  if (!title) return null;
  const rawIngredients = Array.isArray(input.ingredients)
    ? input.ingredients
    : [];
  const rawInstructions = Array.isArray(input.instructions)
    ? input.instructions
    : [];
  return {
    title,
    source: stringValue(input.source)?.trim() || "manual",
    sourceId: nullableStringValue(input.sourceId),
    sourceUrl: nullableStringValue(input.sourceUrl),
    imageUrl: nullableStringValue(input.imageUrl),
    youtubeUrl: nullableStringValue(input.youtubeUrl),
    category: nullableStringValue(input.category),
    area: nullableStringValue(input.area),
    calories: numberValue(input.calories) ?? 0,
    proteinGrams: numberValue(input.proteinGrams) ?? 0,
    carbsGrams: numberValue(input.carbsGrams) ?? 0,
    fatGrams: numberValue(input.fatGrams) ?? 0,
    isFavorite: input.isFavorite === true,
    notes: nullableStringValue(input.notes),
    ingredients: rawIngredients.flatMap(
      (ingredient): RecipeInput["ingredients"] => {
        if (!isRecord(ingredient)) return [];
        const name = stringField(ingredient, "name")?.trim();
        if (!name) return [];
        return [{ name, quantity: nullableStringValue(ingredient.quantity) }];
      },
    ),
    instructions: rawInstructions.flatMap((instruction): string[] => {
      if (typeof instruction !== "string") return [];
      const trimmed = instruction.trim();
      return trimmed ? [trimmed] : [];
    }),
  };
}

export function createRecipe(input: RecipeInput, now = new Date()): Recipe {
  return saveRecipe(randomUUID(), input, now);
}

export function updateRecipe(
  id: string,
  input: RecipeInput,
  now = new Date(),
): Recipe | null {
  if (!getRecipe(id)) return null;
  return saveRecipe(id, input, now);
}

export function deleteRecipe(id: string): boolean {
  return (
    getDatabase().query("DELETE FROM recipes WHERE id = ?1").run(id).changes > 0
  );
}

export function setRecipeFavorite(
  id: string,
  isFavorite: boolean,
  now = new Date(),
): Recipe | null {
  const changes = getDatabase()
    .query("UPDATE recipes SET is_favorite = ?2, updated_at = ?3 WHERE id = ?1")
    .run(id, isFavorite ? 1 : 0, now.toISOString()).changes;
  if (changes === 0) return null;
  return getRecipe(id);
}

export function getRecipe(id: string): Recipe | null {
  const row = getDatabase()
    .query<RecipeRow, [string]>(
      `SELECT ${RECIPE_COLUMNS} FROM recipes WHERE id = ?1`,
    )
    .get(id);
  return row ? rowToRecipe(row) : null;
}

export function listRecipes(): Recipe[] {
  return getDatabase()
    .query<RecipeRow, []>(
      `SELECT ${RECIPE_COLUMNS} FROM recipes ORDER BY is_favorite DESC, updated_at DESC`,
    )
    .all()
    .map(rowToRecipe);
}

export function searchRecipes(query: string): Recipe[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];
  const whereClause = terms.map(() => "instr(lower(title), ?) > 0").join(" AND ");
  return getDatabase()
    .query<RecipeRow, string[]>(
      `SELECT ${RECIPE_COLUMNS} FROM recipes WHERE ${whereClause} ORDER BY is_favorite DESC, updated_at DESC LIMIT 25`,
    )
    .all(...terms)
    .map(rowToRecipe);
}

function saveRecipe(id: string, input: RecipeInput, now: Date): Recipe {
  const timestamp = now.toISOString();
  let recipeId = id;
  if (input.sourceId !== null) {
    const existing = getDatabase()
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM recipes WHERE source = ?1 AND source_id = ?2",
      )
      .get(input.source, input.sourceId);
    if (existing) recipeId = existing.id;
  }
  getDatabase()
    .query(`
    INSERT INTO recipes (id, title, source, source_id, source_url, image_url, youtube_url, category, area, calories, protein_grams, carbs_grams, fat_grams, is_favorite, notes, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      source = excluded.source,
      source_id = excluded.source_id,
      source_url = excluded.source_url,
      image_url = excluded.image_url,
      youtube_url = excluded.youtube_url,
      category = excluded.category,
      area = excluded.area,
      calories = excluded.calories,
      protein_grams = excluded.protein_grams,
      carbs_grams = excluded.carbs_grams,
      fat_grams = excluded.fat_grams,
      is_favorite = excluded.is_favorite,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `)
    .run(
      recipeId,
      input.title,
      input.source,
      input.sourceId,
      input.sourceUrl,
      input.imageUrl,
      input.youtubeUrl,
      input.category,
      input.area,
      input.calories,
      input.proteinGrams,
      input.carbsGrams,
      input.fatGrams,
      input.isFavorite ? 1 : 0,
      input.notes,
      timestamp,
    );
  getDatabase()
    .query("DELETE FROM recipe_ingredients WHERE recipe_id = ?1")
    .run(recipeId);
  getDatabase()
    .query("DELETE FROM recipe_instructions WHERE recipe_id = ?1")
    .run(recipeId);
  const insertIngredient = getDatabase().query(`
    INSERT INTO recipe_ingredients (id, recipe_id, name, quantity, order_index)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `);
  const insertInstruction = getDatabase().query(`
    INSERT INTO recipe_instructions (id, recipe_id, step_index, text)
    VALUES (?1, ?2, ?3, ?4)
  `);
  input.ingredients.forEach((ingredient, index) => {
    insertIngredient.run(
      randomUUID(),
      recipeId,
      ingredient.name,
      ingredient.quantity,
      index,
    );
  });
  input.instructions.forEach((text, index) => {
    insertInstruction.run(randomUUID(), recipeId, index, text);
  });
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error("Saved recipe could not be read.");
  return recipe;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    imageUrl: row.image_url,
    youtubeUrl: row.youtube_url,
    category: row.category,
    area: row.area,
    calories: row.calories,
    proteinGrams: row.protein_grams,
    carbsGrams: row.carbs_grams,
    fatGrams: row.fat_grams,
    isFavorite: row.is_favorite === 1,
    notes: row.notes,
    ingredients: getDatabase()
      .query<RecipeIngredient, [string]>(
        "SELECT id, name, quantity FROM recipe_ingredients WHERE recipe_id = ?1 ORDER BY order_index ASC",
      )
      .all(row.id),
    instructions: getDatabase()
      .query<{ text: string }, [string]>(
        "SELECT text FROM recipe_instructions WHERE recipe_id = ?1 ORDER BY step_index ASC",
      )
      .all(row.id)
      .map((instruction) => instruction.text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
