import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { mutation, query } from "../../_generated/server";
import { requireWorkspace } from "../../platform/auth/access";

const ingredient = v.object({
  name: v.string(),
  quantity: v.optional(v.string()),
});

const source = v.union(
  v.literal("manual"),
  v.literal("agent"),
  v.literal("import"),
  v.literal("google"),
  v.literal("hevy"),
  v.literal("snaptrade"),
  v.literal("csv"),
  v.literal("url"),
  v.literal("themealdb"),
);

function cleanRequired(value: string, label: string): string {
  const result = value.trim();
  if (!result) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} is required` });
  }
  return result;
}

function cleanOptional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${label} must be nonnegative` });
  }
  return value;
}

async function ownedRecipe(
  ctx: QueryCtx | MutationCtx,
  id: Id<"recipes">,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"recipes">> {
  const recipe = await ctx.db.get(id);
  if (recipe === null || recipe.workspaceId !== workspaceId) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Recipe not found" });
  }
  return recipe;
}

async function details(ctx: QueryCtx, recipe: Doc<"recipes">) {
  const [ingredients, instructions] = await Promise.all([
    ctx.db
      .query("recipeIngredients")
      .withIndex("by_recipe_order", (q) => q.eq("recipeId", recipe._id))
      .collect(),
    ctx.db
      .query("recipeInstructions")
      .withIndex("by_recipe_order", (q) => q.eq("recipeId", recipe._id))
      .collect(),
  ]);
  return { ...recipe, ingredients, instructions };
}

async function removeChildren(
  ctx: MutationCtx,
  recipeId: Id<"recipes">,
): Promise<void> {
  const [ingredients, instructions] = await Promise.all([
    ctx.db
      .query("recipeIngredients")
      .withIndex("by_recipe_order", (q) => q.eq("recipeId", recipeId))
      .collect(),
    ctx.db
      .query("recipeInstructions")
      .withIndex("by_recipe_order", (q) => q.eq("recipeId", recipeId))
      .collect(),
  ]);
  for (const item of ingredients) await ctx.db.delete(item._id);
  for (const item of instructions) await ctx.db.delete(item._id);
}

export const list = query({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    favorite: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const recipes =
      args.favorite === undefined
        ? await ctx.db
            .query("recipes")
            .withIndex("by_workspace_updated", (q) =>
              q.eq("workspaceId", access.workspaceId),
            )
            .order("desc")
            .collect()
        : await ctx.db
            .query("recipes")
            .withIndex("by_workspace_favorite", (q) =>
              q
                .eq("workspaceId", access.workspaceId)
                .eq("favorite", args.favorite!),
            )
            .order("desc")
            .collect();
    return Promise.all(recipes.map((recipe) => details(ctx, recipe)));
  },
});

export const search = query({
  args: { workspaceId: v.optional(v.id("workspaces")), query: v.string() },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const search = args.query.trim();
    if (!search) {
      const recipes = await ctx.db
        .query("recipes")
        .withIndex("by_workspace_updated", (q) =>
          q.eq("workspaceId", access.workspaceId),
        )
        .order("desc")
        .take(50);
      return Promise.all(recipes.map((recipe) => details(ctx, recipe)));
    }
    const recipes = await ctx.db
      .query("recipes")
      .withSearchIndex("search_title", (q) =>
        q.search("title", search).eq("workspaceId", access.workspaceId),
      )
      .take(50);
    return Promise.all(recipes.map((recipe) => details(ctx, recipe)));
  },
});

export const get = query({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("recipes") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    return details(ctx, await ownedRecipe(ctx, args.id, access.workspaceId));
  },
});

export const save = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.optional(v.id("recipes")),
    title: v.string(),
    source: v.optional(source),
    sourceId: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    youtubeUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    area: v.optional(v.string()),
    calories: v.number(),
    proteinGrams: v.number(),
    carbsGrams: v.number(),
    fatGrams: v.number(),
    favorite: v.optional(v.boolean()),
    notes: v.optional(v.string()),
    ingredients: v.array(ingredient),
    instructions: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    nonnegative(args.calories, "Calories");
    nonnegative(args.proteinGrams, "Protein");
    nonnegative(args.carbsGrams, "Carbohydrates");
    nonnegative(args.fatGrams, "Fat");
    if (args.ingredients.length > 500 || args.instructions.length > 500) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Recipe is too large" });
    }
    const now = Date.now();
    const value = {
      title: cleanRequired(args.title, "Recipe title"),
      sourceUrl: cleanOptional(args.sourceUrl),
      imageUrl: cleanOptional(args.imageUrl),
      youtubeUrl: cleanOptional(args.youtubeUrl),
      category: cleanOptional(args.category),
      area: cleanOptional(args.area),
      calories: args.calories,
      proteinGrams: args.proteinGrams,
      carbsGrams: args.carbsGrams,
      fatGrams: args.fatGrams,
      notes: cleanOptional(args.notes),
      updatedAt: now,
    };
    const sourceId = cleanOptional(args.sourceId);
    let recipeId = args.id;
    if (recipeId === undefined && sourceId !== undefined) {
      const existing = await ctx.db
        .query("recipes")
        .withIndex("by_workspace_source_id", (q) =>
          q
            .eq("workspaceId", access.workspaceId)
            .eq("source", args.source ?? "manual")
            .eq("sourceId", sourceId),
        )
        .unique();
      recipeId = existing?._id;
    }
    if (recipeId === undefined) {
      recipeId = await ctx.db.insert("recipes", {
        workspaceId: access.workspaceId,
        ...value,
        source: args.source ?? "manual",
        sourceId,
        favorite: args.favorite ?? false,
        createdAt: now,
      });
    } else {
      const recipe = await ownedRecipe(ctx, recipeId, access.workspaceId);
      await removeChildren(ctx, recipe._id);
      await ctx.db.patch(recipe._id, {
        ...value,
        source: args.source ?? recipe.source,
        sourceId: sourceId ?? recipe.sourceId,
        favorite: args.favorite ?? recipe.favorite,
      });
    }
    for (const [order, item] of args.ingredients.entries()) {
      await ctx.db.insert("recipeIngredients", {
        workspaceId: access.workspaceId,
        recipeId,
        name: cleanRequired(item.name, "Ingredient name"),
        quantity: cleanOptional(item.quantity),
        order,
      });
    }
    for (const [order, text] of args.instructions.entries()) {
      await ctx.db.insert("recipeInstructions", {
        workspaceId: access.workspaceId,
        recipeId,
        text: cleanRequired(text, "Instruction"),
        order,
      });
    }
    return recipeId;
  },
});

export const setFavorite = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    id: v.id("recipes"),
    favorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const recipe = await ownedRecipe(ctx, args.id, access.workspaceId);
    await ctx.db.patch(recipe._id, {
      favorite: args.favorite,
      updatedAt: Date.now(),
    });
    return recipe._id;
  },
});

export const remove = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), id: v.id("recipes") },
  handler: async (ctx, args) => {
    const access = await requireWorkspace(ctx, args.workspaceId);
    const recipe = await ownedRecipe(ctx, args.id, access.workspaceId);
    await removeChildren(ctx, recipe._id);
    await ctx.db.delete(recipe._id);
    return recipe._id;
  },
});
