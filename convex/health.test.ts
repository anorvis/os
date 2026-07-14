import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

async function owner() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { email: "owner@example.test" }),
  );
  const client = t.withIdentity({ subject: userId });
  await client.mutation(api.workspaces.ensureDefault, {});
  return { t, client };
}

describe("Health capabilities", () => {
  it("returns meals and active profile in the day dashboard", async () => {
    const { client } = await owner();
    await client.mutation(api.health.saveMeal, {
      name: "Breakfast",
      mealType: "meal",
      loggedAt: 1_500,
      calories: 500,
      proteinGrams: 30,
      carbsGrams: 50,
      fatGrams: 15,
    });
    await client.mutation(api.health.saveMacroProfile, {
      targetCalories: 2_400,
      proteinGrams: 180,
    });

    const dashboard = await client.query(api.health.dashboard, {
      dayStart: 1_000,
      dayEnd: 2_000,
    });
    expect(dashboard.todayMeals).toHaveLength(1);
    expect(dashboard.todayMeals[0].name).toBe("Breakfast");
    expect(dashboard.macroProfile).toMatchObject({
      active: true,
      targetCalories: 2_400,
    });
  });

  it("replaces nested workout children without leaving orphans", async () => {
    const { t, client } = await owner();
    const workoutId = await client.mutation(api.health.saveWorkout, {
      title: "Strength",
      startedAt: 1_000,
      durationSeconds: 3_600,
      exercises: [
        {
          title: "Squat",
          muscleGroups: ["legs"],
          sets: [
            { reps: 5, weightKg: 100 },
            { reps: 5, weightKg: 105 },
          ],
        },
      ],
    });
    await client.mutation(api.health.saveWorkout, {
      id: workoutId,
      title: "Strength revised",
      startedAt: 1_000,
      durationSeconds: 3_000,
      exercises: [{ title: "Deadlift", sets: [{ reps: 3, weightKg: 140 }] }],
    });

    const workout = await client.query(api.health.getWorkout, { id: workoutId });
    expect(workout.title).toBe("Strength revised");
    expect(workout.exercises).toHaveLength(1);
    expect(workout.exercises[0].title).toBe("Deadlift");
    expect(workout.exercises[0].sets).toHaveLength(1);
    const counts = await t.run(async (ctx) => ({
      exercises: (await ctx.db.query("workoutExercises").collect()).length,
      sets: (await ctx.db.query("exerciseSets").collect()).length,
    }));
    expect(counts).toEqual({ exercises: 1, sets: 1 });
  });

  it("upserts imported recipes by source identifier and keeps provenance", async () => {
    const { client } = await owner();
    const input = {
      title: "Soup",
      source: "themealdb" as const,
      sourceId: "meal-42",
      calories: 200,
      proteinGrams: 10,
      carbsGrams: 30,
      fatGrams: 5,
      ingredients: [{ name: "Stock", quantity: "2 cups" }],
      instructions: ["Simmer"],
    };
    const firstId = await client.mutation(api.recipes.save, input);
    const secondId = await client.mutation(api.recipes.save, {
      ...input,
      title: "Updated soup",
      ingredients: [{ name: "Stock", quantity: "3 cups" }],
    });
    expect(secondId).toBe(firstId);

    const recipe = await client.query(api.recipes.get, { id: firstId });
    expect(recipe).toMatchObject({
      title: "Updated soup",
      source: "themealdb",
      sourceId: "meal-42",
    });
    expect(recipe.ingredients).toHaveLength(1);
    expect(recipe.ingredients[0].quantity).toBe("3 cups");
  });

  it("searches saved food through the authenticated Convex action", async () => {
    const { client } = await owner();
    await client.mutation(api.recipes.save, {
      title: "Protein oats",
      calories: 420,
      proteinGrams: 32,
      carbsGrams: 50,
      fatGrams: 10,
      ingredients: [{ name: "Oats" }],
      instructions: ["Mix"],
    });

    const result = await client.action(api.healthSearch.searchFood, {
      query: "protein",
      provider: "recipe",
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        name: "Protein oats",
        calories: 420,
        provider: "recipe",
      }),
    ]);
  });

  it("keeps exactly one active macro profile", async () => {
    const { t, client } = await owner();
    await client.mutation(api.health.saveMacroProfile, { targetCalories: 2_000 });
    const activeId = await client.mutation(api.health.saveMacroProfile, {
      targetCalories: 2_500,
    });
    const profiles = await t.run((ctx) => ctx.db.query("macroProfiles").collect());
    expect(profiles.filter((profile) => profile.active).map((profile) => profile._id)).toEqual([
      activeId,
    ]);
  });
});
