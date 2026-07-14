export type ExternalRecipe = {
  id: string;
  source: "themealdb";
  title: string;
  category: string | null;
  area: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  youtubeUrl: string | null;
  ingredients: Array<{ name: string; quantity: string | null }>;
  instructions: string[];
};

export type FoodSearchResult = {
  id: string;
  name: string;
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  provider: string;
};

export async function searchTheMealDb(query: string): Promise<ExternalRecipe[]> {
  const response = await fetch(
    `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`,
  );
  if (!response.ok) {
    throw new Error(`TheMealDB search failed: ${response.status}`);
  }
  const payload = (await response.json()) as { meals?: unknown };
  const meals = Array.isArray(payload.meals) ? payload.meals : [];
  return meals.flatMap((meal): ExternalRecipe[] => {
    if (!isRecord(meal)) return [];
    const normalized = normalizeTheMealDbMeal(meal);
    return normalized ? [normalized] : [];
  });
}

export function normalizeTheMealDbMeal(
  raw: Record<string, unknown>,
): ExternalRecipe | null {
  const id = textOrNull(raw.idMeal);
  const title = textOrNull(raw.strMeal);
  if (!id || !title) return null;
  const ingredients: ExternalRecipe["ingredients"] = [];
  for (let index = 1; index <= 20; index += 1) {
    const name = textOrNull(raw[`strIngredient${index}`]);
    if (!name) continue;
    ingredients.push({ name, quantity: textOrNull(raw[`strMeasure${index}`]) });
  }
  const rawInstructions =
    typeof raw.strInstructions === "string" ? raw.strInstructions : "";
  const instructions = rawInstructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    id,
    source: "themealdb",
    title,
    category: textOrNull(raw.strCategory),
    area: textOrNull(raw.strArea),
    imageUrl: textOrNull(raw.strMealThumb),
    sourceUrl: textOrNull(raw.strSource),
    youtubeUrl: textOrNull(raw.strYoutube),
    ingredients,
    instructions,
  };
}

export async function searchOpenFoodFacts(
  query: string,
): Promise<FoodSearchResult[]> {
  const response = await fetch(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,nutriments`,
  );
  if (!response.ok) {
    throw new Error(`Open Food Facts search failed: ${response.status}`);
  }
  const payload = (await response.json()) as { products?: unknown };
  const products = Array.isArray(payload.products) ? payload.products : [];
  return products.flatMap((product): FoodSearchResult[] => {
    if (!isRecord(product)) return [];
    const normalized = normalizeOpenFoodFactsProduct(product);
    return normalized ? [normalized] : [];
  });
}

export function normalizeOpenFoodFactsProduct(
  raw: Record<string, unknown>,
): FoodSearchResult | null {
  const id = textOrNull(raw.code);
  const name = textOrNull(raw.product_name);
  if (!id || !name) return null;
  const nutriments: Record<string, unknown> = isRecord(raw.nutriments)
    ? raw.nutriments
    : {};
  const kcal = numberValue(nutriments["energy-kcal_100g"]);
  if (kcal === null || kcal > 900) return null;
  return {
    id,
    name,
    calories: Math.round(kcal),
    proteinGrams: round1(numberValue(nutriments.proteins_100g) ?? 0),
    carbsGrams: round1(numberValue(nutriments.carbohydrates_100g) ?? 0),
    fatGrams: round1(numberValue(nutriments.fat_100g) ?? 0),
    provider: "openfoodfacts",
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function textOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
