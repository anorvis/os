"use node";

import { ConvexError, v } from "convex/values";
import { api, internal } from "../../_generated/api";
import { action } from "../../_generated/server";
import { searchOpenFoodFacts, searchTheMealDb } from "../integration/food";
import { importRecipeFromUrl } from "../integration/recipeImport";

export const searchFood = action({
  args: {
    query: v.string(),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    results: Array<{
      id: string;
      name: string;
      calories: number;
      proteinGrams: number;
      carbsGrams: number;
      fatGrams: number;
      provider: string;
    }>;
  }> => {
    const workspaceId = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      {},
    );
    const query = args.query.trim();
    if (!query) return { results: [] };
    const provider = args.provider ?? "all";
    const results: Array<{
      id: string;
      name: string;
      calories: number;
      proteinGrams: number;
      carbsGrams: number;
      fatGrams: number;
      provider: string;
    }> = [];
    if (provider === "all" || provider === "recipe") {
      const recipes = await ctx.runQuery(api.capability.health.recipes.search, {
        workspaceId,
        query,
      });
      results.push(
        ...recipes.map((recipe) => ({
          id: recipe._id,
          name: recipe.title,
          calories: recipe.calories,
          proteinGrams: recipe.proteinGrams,
          carbsGrams: recipe.carbsGrams,
          fatGrams: recipe.fatGrams,
          provider: "recipe",
        })),
      );
    }
    if (provider === "all" || provider === "openfoodfacts") {
      results.push(...(await searchOpenFoodFacts(query)));
    }
    return { results };
  },
});

export const searchRecipes = action({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.capability.integration.authorizeWorkspace, {});
    const query = args.query.trim();
    return {
      query,
      results: query ? await searchTheMealDb(query) : [],
    };
  },
});

export const importRecipe = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<unknown> => {
    const workspaceId = await ctx.runQuery(
      internal.capability.integration.authorizeWorkspace,
      {},
    );
    const input = await importRecipeFromUrl(args.url);
    const id = await ctx.runMutation(api.capability.health.recipes.save, {
      workspaceId,
      title: input.title,
      source: input.source,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      imageUrl: input.imageUrl,
      youtubeUrl: input.youtubeUrl,
      category: input.category,
      area: input.area,
      calories: input.calories,
      proteinGrams: input.proteinGrams,
      carbsGrams: input.carbsGrams,
      fatGrams: input.fatGrams,
      favorite: input.favorite,
      notes: input.notes,
      ingredients: input.ingredients,
      instructions: input.instructions,
    });
    const recipe = await ctx.runQuery(api.capability.health.recipes.get, { workspaceId, id });
    if (!recipe) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Imported recipe not found" });
    }
    return recipe;
  },
});
