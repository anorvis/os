/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabaseForTests } from "../src/core/db/database";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  type RecipeInput,
  searchRecipes,
  setRecipeFavorite,
  updateRecipe,
} from "../src/capability/health/recipes";
import {
  normalizeOpenFoodFactsProduct,
  normalizeTheMealDbMeal,
} from "../src/capability/integration/food";
import { createApp } from "../src/platform/gateway/app";

type GatewayApp = {
  request(input: string | Request, init?: RequestInit): Promise<Response>;
};

async function withIsolatedHealthDb(run: () => void | Promise<void>): Promise<void> {
  const oldHome = process.env.HOME;
  const oldDbPath = process.env.ANORVIS_DB_PATH;
  const oldToken = process.env.ANORVIS_OS_API_TOKEN;
  const oldSecretProvider = process.env.ANORVIS_SECRET_PROVIDER;
  const home = mkdtempSync(join(tmpdir(), "anorvis-health-recipes-"));
  process.env.HOME = home;
  process.env.ANORVIS_DB_PATH = join(home, ".anorvis", "data", "test.sqlite");
  process.env.ANORVIS_SECRET_PROVIDER = "local";
  delete process.env.ANORVIS_OS_API_TOKEN;
  resetDatabaseForTests();

  try {
    await run();
  } finally {
    resetDatabaseForTests();
    process.env.HOME = oldHome;
    if (oldDbPath === undefined) delete process.env.ANORVIS_DB_PATH;
    else process.env.ANORVIS_DB_PATH = oldDbPath;
    if (oldToken === undefined) delete process.env.ANORVIS_OS_API_TOKEN;
    else process.env.ANORVIS_OS_API_TOKEN = oldToken;
    if (oldSecretProvider === undefined) delete process.env.ANORVIS_SECRET_PROVIDER;
    else process.env.ANORVIS_SECRET_PROVIDER = oldSecretProvider;
  }
}

function recipeInput(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    title: "Base Recipe",
    source: "manual",
    sourceId: null,
    sourceUrl: null,
    imageUrl: null,
    youtubeUrl: null,
    category: null,
    area: null,
    calories: 0,
    proteinGrams: 0,
    carbsGrams: 0,
    fatGrams: 0,
    isFavorite: false,
    notes: null,
    ingredients: [],
    instructions: [],
    ...overrides,
  };
}

function childRowCounts(recipeId: string): { ingredients: number; instructions: number } {
  const ingredients = getDatabase()
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM recipe_ingredients WHERE recipe_id = ?1",
    )
    .get(recipeId);
  const instructions = getDatabase()
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM recipe_instructions WHERE recipe_id = ?1",
    )
    .get(recipeId);
  return {
    ingredients: ingredients?.count ?? -1,
    instructions: instructions?.count ?? -1,
  };
}

describe("recipe persistence", () => {
  test("createRecipe persists ordered children and getRecipe round-trips them", async () => {
    await withIsolatedHealthDb(() => {
      const now = new Date("2026-02-10T12:00:00.000Z");
      const created = createRecipe(
        recipeInput({
          title: "Skillet Chili",
          source: "manual",
          calories: 610,
          proteinGrams: 42,
          carbsGrams: 55,
          fatGrams: 21,
          // Deliberately non-alphabetical and non-reversed so a re-sort bug is caught.
          ingredients: [
            { name: "Tomato paste", quantity: "2 tbsp" },
            { name: "Ground beef", quantity: "1 lb" },
            { name: "Kidney beans", quantity: null },
          ],
          instructions: ["Brown the beef", "Add beans and paste", "Simmer 30 min"],
        }),
        now,
      );

      const fetched = getRecipe(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched).toEqual(
        expect.objectContaining({
          id: created.id,
          title: "Skillet Chili",
          source: "manual",
          calories: 610,
          proteinGrams: 42,
          carbsGrams: 55,
          fatGrams: 21,
          isFavorite: false,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      );
      expect(fetched?.ingredients.map((i) => ({ name: i.name, quantity: i.quantity }))).toEqual([
        { name: "Tomato paste", quantity: "2 tbsp" },
        { name: "Ground beef", quantity: "1 lb" },
        { name: "Kidney beans", quantity: null },
      ]);
      expect(fetched?.instructions).toEqual([
        "Brown the beef",
        "Add beans and paste",
        "Simmer 30 min",
      ]);
      expect(listRecipes().map((r) => r.id)).toEqual([created.id]);
    });
  });

  test("listRecipes orders favourites first then most-recently-updated", async () => {
    await withIsolatedHealthDb(() => {
      const older = createRecipe(
        recipeInput({ title: "Older non-favourite" }),
        new Date("2026-01-01T00:00:00.000Z"),
      );
      const newer = createRecipe(
        recipeInput({ title: "Newer non-favourite" }),
        new Date("2026-03-01T00:00:00.000Z"),
      );
      // Oldest timestamp but favourite: must still sort ahead of both non-favourites.
      const favourite = createRecipe(
        recipeInput({ title: "Oldest favourite", isFavorite: true }),
        new Date("2025-12-01T00:00:00.000Z"),
      );

      expect(listRecipes().map((r) => r.id)).toEqual([favourite.id, newer.id, older.id]);
    });
  });

  test("updateRecipe replaces children and scalars, preserves createdAt, and 404s for unknown id", async () => {
    await withIsolatedHealthDb(() => {
      const createdAt = new Date("2026-04-01T09:00:00.000Z");
      const updatedAt = new Date("2026-04-05T18:30:00.000Z");
      const created = createRecipe(
        recipeInput({
          title: "Draft",
          calories: 100,
          ingredients: [
            { name: "old-a", quantity: "1" },
            { name: "old-b", quantity: "2" },
          ],
          instructions: ["old step 1", "old step 2"],
        }),
        createdAt,
      );

      const updated = updateRecipe(
        created.id,
        recipeInput({
          title: "Final",
          calories: 250,
          ingredients: [{ name: "new-only", quantity: null }],
          instructions: ["only step"],
        }),
        updatedAt,
      );

      expect(updated?.id).toBe(created.id);
      expect(updated?.title).toBe("Final");
      expect(updated?.calories).toBe(250);
      expect(updated?.createdAt).toBe(createdAt.toISOString());
      expect(updated?.updatedAt).toBe(updatedAt.toISOString());
      expect(updated?.ingredients.map((i) => i.name)).toEqual(["new-only"]);
      expect(updated?.instructions).toEqual(["only step"]);
      // Old children fully replaced, not appended.
      expect(childRowCounts(created.id)).toEqual({ ingredients: 1, instructions: 1 });

      expect(updateRecipe("does-not-exist", recipeInput({ title: "ghost" }))).toBeNull();
    });
  });

  test("setRecipeFavorite toggles the flag and returns null for unknown id", async () => {
    await withIsolatedHealthDb(() => {
      const created = createRecipe(
        recipeInput({ title: "Toggle me" }),
        new Date("2026-05-01T00:00:00.000Z"),
      );
      expect(created.isFavorite).toBe(false);

      const favourited = setRecipeFavorite(
        created.id,
        true,
        new Date("2026-05-02T00:00:00.000Z"),
      );
      expect(favourited?.isFavorite).toBe(true);
      expect(favourited?.updatedAt).toBe(new Date("2026-05-02T00:00:00.000Z").toISOString());

      const unfavourited = setRecipeFavorite(
        created.id,
        false,
        new Date("2026-05-03T00:00:00.000Z"),
      );
      expect(unfavourited?.isFavorite).toBe(false);

      expect(setRecipeFavorite("does-not-exist", true)).toBeNull();
    });
  });

  test("deleteRecipe cascades child rows and returns false for unknown id", async () => {
    await withIsolatedHealthDb(() => {
      const created = createRecipe(
        recipeInput({
          title: "Disposable",
          ingredients: [
            { name: "a", quantity: null },
            { name: "b", quantity: null },
          ],
          instructions: ["s1", "s2", "s3"],
        }),
      );
      expect(childRowCounts(created.id)).toEqual({ ingredients: 2, instructions: 3 });

      expect(deleteRecipe(created.id)).toBe(true);
      expect(getRecipe(created.id)).toBeNull();
      // ON DELETE CASCADE must remove the ordered child rows.
      expect(childRowCounts(created.id)).toEqual({ ingredients: 0, instructions: 0 });

      expect(deleteRecipe("does-not-exist")).toBe(false);
    });
  });

  test("saving with an identical source+sourceId is idempotent and updates in place", async () => {
    await withIsolatedHealthDb(() => {
      const first = createRecipe(
        recipeInput({
          title: "TheMealDB import v1",
          source: "themealdb",
          sourceId: "52772",
          ingredients: [{ name: "soy sauce", quantity: "1 cup" }],
          instructions: ["step one"],
        }),
        new Date("2026-06-01T00:00:00.000Z"),
      );
      const second = createRecipe(
        recipeInput({
          title: "TheMealDB import v2",
          source: "themealdb",
          sourceId: "52772",
          ingredients: [
            { name: "soy sauce", quantity: "3/4 cup" },
            { name: "chicken", quantity: "1 lb" },
          ],
          instructions: ["step one", "step two"],
        }),
        new Date("2026-06-02T00:00:00.000Z"),
      );

      // Same source+sourceId reuses the row rather than inserting a duplicate.
      expect(second.id).toBe(first.id);
      const rows = listRecipes();
      expect(rows.length).toBe(1);
      expect(rows[0]?.title).toBe("TheMealDB import v2");
      expect(rows[0]?.ingredients.map((i) => i.name)).toEqual(["soy sauce", "chicken"]);
      expect(rows[0]?.instructions).toEqual(["step one", "step two"]);
    });
  });

  test("a null sourceId (or a differing source) never deduplicates", async () => {
    await withIsolatedHealthDb(() => {
      const manualA = createRecipe(recipeInput({ title: "Manual A", source: "manual", sourceId: null }));
      const manualB = createRecipe(recipeInput({ title: "Manual B", source: "manual", sourceId: null }));
      expect(manualB.id).not.toBe(manualA.id);

      const mealDb = createRecipe(recipeInput({ title: "Shared id, other source", source: "themealdb", sourceId: "9001" }));
      const offImport = createRecipe(recipeInput({ title: "Shared id, off source", source: "openfoodfacts", sourceId: "9001" }));
      expect(offImport.id).not.toBe(mealDb.id);

      expect(listRecipes().length).toBe(4);
    });
  });

  test("searchRecipes matches all lowercased title terms and rejects blank queries", async () => {
    await withIsolatedHealthDb(() => {
      createRecipe(recipeInput({ title: "Chicken Curry" }), new Date("2026-07-01T00:00:00.000Z"));
      createRecipe(recipeInput({ title: "Chicken Soup" }), new Date("2026-07-02T00:00:00.000Z"));
      createRecipe(recipeInput({ title: "Beef Stew" }), new Date("2026-07-03T00:00:00.000Z"));

      // Every term must be present in the title (AND semantics).
      expect(searchRecipes("chicken curry").map((r) => r.title)).toEqual(["Chicken Curry"]);
      // Case-insensitive; ordered by most-recently-updated first.
      expect(searchRecipes("CHICKEN").map((r) => r.title)).toEqual(["Chicken Soup", "Chicken Curry"]);
      expect(searchRecipes("beef stew").map((r) => r.title)).toEqual(["Beef Stew"]);
      // No single title contains both terms.
      expect(searchRecipes("chicken stew")).toEqual([]);
      // Blank / whitespace-only queries return nothing.
      expect(searchRecipes("   ")).toEqual([]);
      expect(searchRecipes("")).toEqual([]);
    });
  });
});

describe("recipe HTTP contract", () => {
  test("POST /v1/health/recipes parses, filters, and orders children; invalid body rejected", async () => {
    await withIsolatedHealthDb(async () => {
      const app: GatewayApp = createApp();

      const createResponse = await app.request("/v1/health/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "  Sheet Pan Salmon  ",
          source: "themealdb",
          sourceId: "10001",
          calories: 520,
          proteinGrams: 40,
          carbsGrams: 18,
          fatGrams: 30,
          ingredients: [
            { name: "salmon", quantity: "2 fillets" },
            { name: "   ", quantity: "drop me" },
            "not-an-object",
            { name: "asparagus", quantity: null },
          ],
          instructions: ["Preheat", "   ", "Roast 15 min", ""],
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        id: string;
        title: string;
        source: string;
        sourceId: string | null;
        calories: number;
        isFavorite: boolean;
        ingredients: Array<{ name: string; quantity: string | null }>;
        instructions: string[];
      };
      expect(created).toEqual(
        expect.objectContaining({
          title: "Sheet Pan Salmon",
          source: "themealdb",
          sourceId: "10001",
          calories: 520,
          isFavorite: false,
          instructions: ["Preheat", "Roast 15 min"],
        }),
      );
      // Invalid ingredient entries filtered out; survivors keep their input order.
      expect(created.ingredients.map((i) => ({ name: i.name, quantity: i.quantity }))).toEqual([
        { name: "salmon", quantity: "2 fillets" },
        { name: "asparagus", quantity: null },
      ]);

      const listResponse = await app.request("/v1/health/recipes");
      expect(listResponse.status).toBe(200);
      const listed = (await listResponse.json()) as { recipes: Array<{ id: string }> };
      expect(listed.recipes.some((r) => r.id === created.id)).toBe(true);

      const invalidResponse = await app.request("/v1/health/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "   " }),
      });
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toEqual({ error: "invalid recipe input" });
    });
  });

  test("recipe favorite body gate, delete lifecycle, and 404s for unknown ids", async () => {
    await withIsolatedHealthDb(async () => {
      const app: GatewayApp = createApp();

      const createResponse = await app.request("/v1/health/recipes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Lifecycle recipe", source: "manual" }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { id: string };

      const favOn = await app.request(
        `/v1/health/recipes/${encodeURIComponent(created.id)}/favorite`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isFavorite: true }),
        },
      );
      expect(favOn.status).toBe(200);
      expect((await favOn.json()) as { isFavorite: boolean }).toEqual(
        expect.objectContaining({ isFavorite: true }),
      );

      // Missing / falsy isFavorite is treated as false by the route gate.
      const favOff = await app.request(
        `/v1/health/recipes/${encodeURIComponent(created.id)}/favorite`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(favOff.status).toBe(200);
      expect((await favOff.json()) as { isFavorite: boolean }).toEqual(
        expect.objectContaining({ isFavorite: false }),
      );

      const updateMissing = await app.request(
        "/v1/health/recipes/does-not-exist",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "ghost" }),
        },
      );
      expect(updateMissing.status).toBe(404);
      expect(await updateMissing.json()).toEqual({ error: "recipe not found" });

      const deleteMissing = await app.request("/v1/health/recipes/does-not-exist", { method: "DELETE" });
      expect(deleteMissing.status).toBe(404);
      expect(await deleteMissing.json()).toEqual({ error: "recipe not found" });

      const favMissing = await app.request(
        "/v1/health/recipes/does-not-exist/favorite",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isFavorite: true }),
        },
      );
      expect(favMissing.status).toBe(404);
      expect(await favMissing.json()).toEqual({ error: "recipe not found" });

      const deleteResponse = await app.request(`/v1/health/recipes/${encodeURIComponent(created.id)}`, { method: "DELETE" });
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ ok: true });

      const afterDelete = await app.request("/v1/health/recipes");
      const afterList = (await afterDelete.json()) as { recipes: Array<{ id: string }> };
      expect(afterList.recipes.some((r) => r.id === created.id)).toBe(false);
    });
  });
});

describe("normalizeTheMealDbMeal", () => {
  test("maps fields, collects ingredients skipping gaps, and splits instructions", () => {
    const normalized = normalizeTheMealDbMeal({
      idMeal: "52772",
      strMeal: "Teriyaki Chicken Casserole",
      strCategory: "Chicken",
      strArea: "Japanese",
      strMealThumb: "https://img.test/teriyaki.jpg",
      strSource: "https://example.test/teriyaki",
      strYoutube: "https://youtube.test/abc",
      strInstructions: "Preheat oven to 350.\n\nMix the sauce.\r\nBake 30 min.\n   \n",
      strIngredient1: "soy sauce",
      strMeasure1: "3/4 cup",
      strIngredient2: "   ",
      strMeasure2: "ignored",
      strIngredient3: "brown sugar",
      strMeasure3: "   ",
      strIngredient4: "chicken",
      strMeasure4: "1 lb",
      strIngredient5: "",
      strMeasure5: "",
    });

    expect(normalized).not.toBeNull();
    expect(normalized).toEqual(
      expect.objectContaining({
        id: "52772",
        source: "themealdb",
        title: "Teriyaki Chicken Casserole",
        category: "Chicken",
        area: "Japanese",
        imageUrl: "https://img.test/teriyaki.jpg",
        sourceUrl: "https://example.test/teriyaki",
        youtubeUrl: "https://youtube.test/abc",
      }),
    );
    // Blank-named ingredient (index 2) skipped; order 1,3,4 preserved; blank measure -> null.
    expect(normalized?.ingredients).toEqual([
      { name: "soy sauce", quantity: "3/4 cup" },
      { name: "brown sugar", quantity: null },
      { name: "chicken", quantity: "1 lb" },
    ]);
    // Split on \n and \r\n; whitespace-only and empty lines dropped.
    expect(normalized?.instructions).toEqual([
      "Preheat oven to 350.",
      "Mix the sauce.",
      "Bake 30 min.",
    ]);
  });

  test("optional metadata absent yields nulls and empty children", () => {
    const normalized = normalizeTheMealDbMeal({
      idMeal: "1",
      strMeal: "Bare Meal",
    });
    expect(normalized).toEqual({
      id: "1",
      source: "themealdb",
      title: "Bare Meal",
      category: null,
      area: null,
      imageUrl: null,
      sourceUrl: null,
      youtubeUrl: null,
      ingredients: [],
      instructions: [],
    });
  });

  test("returns null when idMeal or strMeal is missing or blank", () => {
    const cases: Array<{ name: string; raw: Record<string, unknown> }> = [
      { name: "missing idMeal", raw: { strMeal: "No id" } },
      { name: "blank idMeal", raw: { idMeal: "   ", strMeal: "No id" } },
      { name: "missing strMeal", raw: { idMeal: "42" } },
      { name: "blank strMeal", raw: { idMeal: "42", strMeal: "   " } },
      { name: "non-string idMeal", raw: { idMeal: 42, strMeal: "Numeric id" } },
    ];
    for (const { name, raw } of cases) {
      expect({ name, result: normalizeTheMealDbMeal(raw) }).toEqual({ name, result: null });
    }
  });
});

describe("normalizeOpenFoodFactsProduct", () => {
  test("rounds calories and macro grams to whole/one-decimal values", () => {
    const normalized = normalizeOpenFoodFactsProduct({
      code: "3017620422003",
      product_name: "Hazelnut Spread",
      nutriments: {
        "energy-kcal_100g": 250.6,
        proteins_100g: 12.34,
        carbohydrates_100g: 30.08,
        fat_100g: 9.92,
      },
    });
    expect(normalized).toEqual({
      id: "3017620422003",
      name: "Hazelnut Spread",
      provider: "openfoodfacts",
      calories: 251,
      proteinGrams: 12.3,
      carbsGrams: 30.1,
      fatGrams: 9.9,
    });
  });

  test("missing macro fields default to zero and the 900 kcal ceiling is inclusive", () => {
    const normalized = normalizeOpenFoodFactsProduct({
      code: "0001",
      product_name: "Energy Only",
      nutriments: { "energy-kcal_100g": 900 },
    });
    expect(normalized).toEqual({
      id: "0001",
      name: "Energy Only",
      provider: "openfoodfacts",
      calories: 900,
      proteinGrams: 0,
      carbsGrams: 0,
      fatGrams: 0,
    });
  });

  test("rejects invalid rows", () => {
    const cases: Array<{ name: string; raw: Record<string, unknown> }> = [
      { name: "missing code", raw: { product_name: "No code", nutriments: { "energy-kcal_100g": 100 } } },
      { name: "missing product_name", raw: { code: "1", nutriments: { "energy-kcal_100g": 100 } } },
      { name: "missing kcal", raw: { code: "1", product_name: "No kcal", nutriments: { proteins_100g: 5 } } },
      { name: "non-numeric kcal", raw: { code: "1", product_name: "String kcal", nutriments: { "energy-kcal_100g": "120" } } },
      { name: "kcal above ceiling", raw: { code: "1", product_name: "Too dense", nutriments: { "energy-kcal_100g": 901 } } },
      { name: "nutriments not an object", raw: { code: "1", product_name: "No nutriments" } },
    ];
    for (const { name, raw } of cases) {
      expect({ name, result: normalizeOpenFoodFactsProduct(raw) }).toEqual({ name, result: null });
    }
  });
});
