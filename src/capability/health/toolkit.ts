import { Schema } from "effect";
import {
  parametersFromSchema,
  type ToolkitTool,
} from "../../platform/toolkit/schema";

const EmptyParameters = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const NullableStringSchema = Schema.Union(Schema.String, Schema.Null);
const NullableNumberSchema = Schema.Union(Schema.Number, Schema.Null);

const IdSchema = Schema.Struct({
  id: Schema.String.annotations({ description: "Existing resource id." }),
});

const MealInputSchema = Schema.Struct({
  name: Schema.String.annotations({ description: "Meal name." }),
  mealType: Schema.String.annotations({
    description: "Meal type, e.g. breakfast, lunch, dinner, or snack.",
  }),
  loggedAt: Schema.String.annotations({
    description: "ISO timestamp when the meal was logged.",
  }),
  calories: Schema.optional(
    Schema.Number.annotations({ description: "Meal calories." }),
  ),
  proteinGrams: Schema.optional(
    Schema.Number.annotations({ description: "Protein grams." }),
  ),
  carbsGrams: Schema.optional(
    Schema.Number.annotations({ description: "Carbohydrate grams." }),
  ),
  fatGrams: Schema.optional(
    Schema.Number.annotations({ description: "Fat grams." }),
  ),
  source: Schema.optional(
    Schema.String.annotations({
      description: "Meal source; defaults to manual.",
    }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional meal notes." }),
  ),
});

const MealUpdateSchema = Schema.extend(IdSchema, MealInputSchema).annotations({
  description: "Existing meal id plus replacement meal body.",
});

const MacroProfileSchema = Schema.Struct({
  goal: Schema.String.annotations({
    description: "Nutrition goal, e.g. maintain, lose, or gain.",
  }),
  sex: Schema.String.annotations({
    description: "Sex used for target calculations.",
  }),
  age: Schema.Number.annotations({ description: "Age in years." }),
  heightCm: Schema.Number.annotations({
    description: "Height in centimeters.",
  }),
  weightKg: Schema.Number.annotations({ description: "Weight in kilograms." }),
  bodyFatPercent: Schema.optional(
    NullableNumberSchema.annotations({
      description: "Optional body fat percentage.",
    }),
  ),
  activityLevel: Schema.String.annotations({
    description: "Activity level used for target calculations.",
  }),
  birthdate: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional birthdate." }),
  ),
  trainingDaysPerWeek: Schema.Number.annotations({
    description: "Training days per week.",
  }),
  targetCalories: Schema.Number.annotations({
    description: "Daily target calories.",
  }),
  proteinGrams: Schema.Number.annotations({
    description: "Daily protein target in grams.",
  }),
  carbsGrams: Schema.Number.annotations({
    description: "Daily carbohydrate target in grams.",
  }),
  fatGrams: Schema.Number.annotations({
    description: "Daily fat target in grams.",
  }),
});

const WorkoutSetSchema = Schema.Struct({
  setType: Schema.optional(
    Schema.String.annotations({ description: "Set type; defaults to normal." }),
  ),
  reps: Schema.optional(
    NullableNumberSchema.annotations({ description: "Repetition count." }),
  ),
  weightKg: Schema.optional(
    NullableNumberSchema.annotations({ description: "Weight in kilograms." }),
  ),
  durationSeconds: Schema.optional(
    NullableNumberSchema.annotations({
      description: "Set duration in seconds.",
    }),
  ),
  distanceMeters: Schema.optional(
    NullableNumberSchema.annotations({ description: "Distance in meters." }),
  ),
});

const WorkoutExerciseSchema = Schema.Struct({
  title: Schema.String.annotations({ description: "Exercise title." }),
  muscleGroups: Schema.optional(
    Schema.Array(Schema.String).annotations({
      description: "Optional muscle groups.",
    }),
  ),
  sets: Schema.Array(WorkoutSetSchema).annotations({
    description: "Workout sets for this exercise.",
  }),
});

const WorkoutInputSchema = Schema.Struct({
  title: Schema.String.annotations({ description: "Workout title." }),
  startedAt: Schema.String.annotations({
    description: "ISO timestamp when the workout started.",
  }),
  durationSeconds: Schema.optional(
    Schema.Number.annotations({ description: "Workout duration in seconds." }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({
      description: "Optional workout notes.",
    }),
  ),
  source: Schema.optional(
    Schema.String.annotations({
      description: "Workout source; defaults to manual.",
    }),
  ),
  exercises: Schema.optional(
    Schema.Array(WorkoutExerciseSchema).annotations({
      description: "Workout exercises.",
    }),
  ),
});

const WorkoutUpdateSchema = Schema.extend(
  IdSchema,
  WorkoutInputSchema,
).annotations({
  description: "Existing workout id plus replacement workout body.",
});

const RecipeIngredientSchema = Schema.Struct({
  name: Schema.String.annotations({ description: "Ingredient name." }),
  quantity: Schema.optional(
    NullableStringSchema.annotations({
      description: "Ingredient quantity text.",
    }),
  ),
});

const RecipeInputSchema = Schema.Struct({
  title: Schema.String.annotations({ description: "Recipe title." }),
  source: Schema.optional(
    Schema.String.annotations({
      description: "Recipe source; defaults to manual.",
    }),
  ),
  sourceId: Schema.optional(
    NullableStringSchema.annotations({
      description: "Optional source recipe id.",
    }),
  ),
  sourceUrl: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional source URL." }),
  ),
  imageUrl: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional image URL." }),
  ),
  youtubeUrl: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional YouTube URL." }),
  ),
  category: Schema.optional(
    NullableStringSchema.annotations({
      description: "Optional recipe category.",
    }),
  ),
  area: Schema.optional(
    NullableStringSchema.annotations({
      description: "Optional cuisine or area.",
    }),
  ),
  calories: Schema.optional(
    Schema.Number.annotations({ description: "Recipe calories." }),
  ),
  proteinGrams: Schema.optional(
    Schema.Number.annotations({ description: "Protein grams." }),
  ),
  carbsGrams: Schema.optional(
    Schema.Number.annotations({ description: "Carbohydrate grams." }),
  ),
  fatGrams: Schema.optional(
    Schema.Number.annotations({ description: "Fat grams." }),
  ),
  isFavorite: Schema.optional(
    Schema.Boolean.annotations({
      description: "Whether the recipe is favorited.",
    }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({ description: "Optional recipe notes." }),
  ),
  ingredients: Schema.optional(
    Schema.Array(RecipeIngredientSchema).annotations({
      description: "Recipe ingredients.",
    }),
  ),
  instructions: Schema.optional(
    Schema.Array(Schema.String).annotations({
      description: "Recipe instruction steps.",
    }),
  ),
});

const RecipeUpdateSchema = Schema.extend(
  IdSchema,
  RecipeInputSchema,
).annotations({
  description: "Existing recipe id plus replacement recipe body.",
});

const RecipeImportSchema = Schema.Struct({
  url: Schema.String.annotations({ description: "Recipe URL to import." }),
});

const RecipeFavoriteSchema = Schema.Struct({
  id: Schema.String.annotations({
    description: "Recipe id to favorite or unfavorite.",
  }),
  isFavorite: Schema.Boolean.annotations({
    description: "Favorite state to apply.",
  }),
});

const RecipeSearchSchema = Schema.Struct({
  q: Schema.String.annotations({ description: "Recipe search query." }),
});

const FoodSearchSchema = Schema.Struct({
  q: Schema.String.annotations({ description: "Food search query." }),
  provider: Schema.optional(
    Schema.Literal("all", "recipe", "openfoodfacts").annotations({
      description: "Food search provider; defaults to all.",
    }),
  ),
});

const HevySettingsSchema = Schema.Struct({
  apiKey: Schema.String.annotations({ description: "Hevy API key to save." }),
});

const HevyRoutineSetSchema = Schema.Struct({
  type: Schema.optional(
    Schema.String.annotations({
      description: "Hevy set type; defaults to normal.",
    }),
  ),
  reps: Schema.optional(
    NullableNumberSchema.annotations({ description: "Repetition count." }),
  ),
  weightKg: Schema.optional(
    NullableNumberSchema.annotations({ description: "Weight in kilograms." }),
  ),
  durationSeconds: Schema.optional(
    NullableNumberSchema.annotations({ description: "Duration in seconds." }),
  ),
  distanceMeters: Schema.optional(
    NullableNumberSchema.annotations({ description: "Distance in meters." }),
  ),
  customMetric: Schema.optional(
    NullableNumberSchema.annotations({
      description: "Custom Hevy metric value.",
    }),
  ),
  repRange: Schema.optional(
    Schema.Union(
      Schema.Struct({
        start: Schema.optional(
          NullableNumberSchema.annotations({ description: "Rep range start." }),
        ),
        end: Schema.optional(
          NullableNumberSchema.annotations({ description: "Rep range end." }),
        ),
      }),
      Schema.Null,
    ).annotations({ description: "Optional rep range." }),
  ),
});

const HevyRoutineCreateSetSchema = Schema.Struct({
  type: Schema.Literal("warmup", "normal", "failure", "dropset").annotations({
    description: "Hevy set type.",
  }),
  reps: Schema.optional(
    NullableNumberSchema.annotations({ description: "Repetition count." }),
  ),
  weightKg: Schema.optional(
    NullableNumberSchema.annotations({ description: "Weight in kilograms." }),
  ),
  durationSeconds: Schema.optional(
    NullableNumberSchema.annotations({ description: "Duration in seconds." }),
  ),
  distanceMeters: Schema.optional(
    NullableNumberSchema.annotations({ description: "Distance in meters." }),
  ),
  customMetric: Schema.optional(
    NullableNumberSchema.annotations({
      description: "Custom Hevy metric value.",
    }),
  ),
  repRange: Schema.optional(
    Schema.Union(
      Schema.Struct({
        start: Schema.optional(
          NullableNumberSchema.annotations({ description: "Rep range start." }),
        ),
        end: Schema.optional(
          NullableNumberSchema.annotations({ description: "Rep range end." }),
        ),
      }),
      Schema.Null,
    ).annotations({ description: "Optional rep range." }),
  ),
});

const HevyRoutineCreateExerciseSchema = Schema.Struct({
  title: Schema.optional(
    Schema.String.annotations({
      description:
        "Exercise title; defaults to exerciseTemplateId when omitted.",
    }),
  ),
  exerciseTemplateId: Schema.String.annotations({
    description: "Hevy exercise template id.",
  }),
  restSeconds: Schema.optional(
    NullableNumberSchema.annotations({ description: "Rest seconds." }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({ description: "Exercise notes." }),
  ),
  supersetId: Schema.optional(
    NullableNumberSchema.annotations({ description: "Superset id." }),
  ),
  sets: Schema.Array(HevyRoutineCreateSetSchema).annotations({
    description: "Routine sets; at least one set is required by the route.",
  }),
});

const HevyRoutineCreateSchema = Schema.Struct({
  title: Schema.String.annotations({ description: "Routine title." }),
  folderId: Schema.optional(
    NullableNumberSchema.annotations({
      description: "Optional Hevy routine folder id.",
    }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({ description: "Routine notes." }),
  ),
  exercises: Schema.Array(HevyRoutineCreateExerciseSchema).annotations({
    description:
      "Routine exercises; at least one exercise is required by the route.",
  }),
});

const HevyRoutineExerciseSchema = Schema.Struct({
  title: Schema.String.annotations({ description: "Exercise title." }),
  exerciseTemplateId: Schema.String.annotations({
    description: "Hevy exercise template id.",
  }),
  restSeconds: Schema.optional(
    NullableNumberSchema.annotations({ description: "Rest seconds." }),
  ),
  notes: Schema.optional(
    NullableStringSchema.annotations({ description: "Exercise notes." }),
  ),
  supersetId: Schema.optional(
    NullableNumberSchema.annotations({ description: "Superset id." }),
  ),
  sets: Schema.Array(HevyRoutineSetSchema).annotations({
    description: "Routine sets.",
  }),
});

const HevyRoutineUpdateSchema = Schema.Struct({
  routineId: Schema.String.annotations({
    description: "Hevy routine id in the route path.",
  }),
  id: Schema.String.annotations({
    description: "Hevy routine id in the request body.",
  }),
  title: Schema.String.annotations({ description: "Routine title." }),
  updatedAt: Schema.optional(
    NullableStringSchema.annotations({
      description: "Routine updated timestamp.",
    }),
  ),
  exercises: Schema.Array(HevyRoutineExerciseSchema).annotations({
    description: "Routine exercises.",
  }),
});

export const healthToolkitTools = [
  {
    id: "health_dashboard.read",
    name: "anorvis_read_health_dashboard",
    label: "Read Health Dashboard",
    description: "Read the Health dashboard from Anorvis OS.",
    domain: "health",
    operation: "read",
    resource: "health_dashboard",
    mutates: false,
    method: "GET",
    path: "/v1/health/dashboard",
    parameters: EmptyParameters,
  },
  {
    id: "meal.list",
    name: "anorvis_list_meals",
    label: "List Meals",
    description: "List meals from the Health dashboard.",
    domain: "health",
    operation: "read",
    resource: "meal",
    mutates: false,
    method: "GET",
    path: "/v1/health/dashboard",
    parameters: EmptyParameters,
  },
  {
    id: "meal.create",
    name: "anorvis_create_meal",
    label: "Create Meal",
    description: "Create a Health meal in Anorvis OS.",
    domain: "health",
    operation: "create",
    resource: "meal",
    mutates: true,
    method: "POST",
    path: "/v1/health/meals",
    parameters: parametersFromSchema(MealInputSchema),
  },
  {
    id: "meal.update",
    name: "anorvis_update_meal",
    label: "Update Meal",
    description: "Replace an existing Health meal in Anorvis OS.",
    domain: "health",
    operation: "update",
    resource: "meal",
    mutates: true,
    method: "PUT",
    path: "/v1/health/meals/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(MealUpdateSchema),
  },
  {
    id: "meal.delete",
    name: "anorvis_delete_meal",
    label: "Delete Meal",
    description: "Permanently delete a Health meal from Anorvis OS.",
    domain: "health",
    operation: "delete",
    resource: "meal",
    mutates: true,
    method: "DELETE",
    path: "/v1/health/meals/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(IdSchema),
  },
  {
    id: "macro_profile.read",
    name: "anorvis_read_macro_profile",
    label: "Read Macro Profile",
    description: "Read the active macro profile from the Health dashboard.",
    domain: "health",
    operation: "read",
    resource: "macro_profile",
    mutates: false,
    method: "GET",
    path: "/v1/health/dashboard",
    parameters: EmptyParameters,
  },
  {
    id: "macro_profile.update",
    name: "anorvis_update_macro_profile",
    label: "Update Macro Profile",
    description: "Create a new active macro profile in Anorvis OS.",
    domain: "health",
    operation: "update",
    resource: "macro_profile",
    mutates: true,
    method: "POST",
    path: "/v1/health/macro-profile",
    parameters: parametersFromSchema(MacroProfileSchema),
  },
  {
    id: "workout.list",
    name: "anorvis_list_workouts",
    label: "List Workouts",
    description: "List workouts from the Health dashboard.",
    domain: "health",
    operation: "read",
    resource: "workout",
    mutates: false,
    method: "GET",
    path: "/v1/health/dashboard",
    parameters: EmptyParameters,
  },
  {
    id: "workout.create",
    name: "anorvis_create_workout",
    label: "Create Workout",
    description: "Create a Health workout in Anorvis OS.",
    domain: "health",
    operation: "create",
    resource: "workout",
    mutates: true,
    method: "POST",
    path: "/v1/health/workouts",
    parameters: parametersFromSchema(WorkoutInputSchema),
  },
  {
    id: "workout.update",
    name: "anorvis_update_workout",
    label: "Update Workout",
    description: "Replace an existing Health workout in Anorvis OS.",
    domain: "health",
    operation: "update",
    resource: "workout",
    mutates: true,
    method: "PUT",
    path: "/v1/health/workouts/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(WorkoutUpdateSchema),
  },
  {
    id: "body_measurement.list",
    name: "anorvis_list_body_measurements",
    label: "List Body Measurements",
    description: "List body measurements from the Health dashboard.",
    domain: "health",
    operation: "read",
    resource: "body_measurement",
    mutates: false,
    method: "GET",
    path: "/v1/health/dashboard",
    parameters: EmptyParameters,
  },
  {
    id: "recipe.list",
    name: "anorvis_list_recipes",
    label: "List Recipes",
    description: "List Health recipes in Anorvis OS.",
    domain: "health",
    operation: "read",
    resource: "recipe",
    mutates: false,
    method: "GET",
    path: "/v1/health/recipes",
    parameters: EmptyParameters,
  },
  {
    id: "recipe.create",
    name: "anorvis_create_recipe",
    label: "Create Recipe",
    description: "Create a Health recipe in Anorvis OS.",
    domain: "health",
    operation: "create",
    resource: "recipe",
    mutates: true,
    method: "POST",
    path: "/v1/health/recipes",
    parameters: parametersFromSchema(RecipeInputSchema),
  },
  {
    id: "recipe_import.create",
    name: "anorvis_import_recipe",
    label: "Import Recipe",
    description: "Import a Health recipe from a URL.",
    domain: "health",
    operation: "create",
    resource: "recipe_import",
    mutates: true,
    method: "POST",
    path: "/v1/health/recipes/import",
    parameters: parametersFromSchema(RecipeImportSchema),
  },
  {
    id: "recipe.update",
    name: "anorvis_update_recipe",
    label: "Update Recipe",
    description: "Replace an existing Health recipe in Anorvis OS.",
    domain: "health",
    operation: "update",
    resource: "recipe",
    mutates: true,
    method: "PUT",
    path: "/v1/health/recipes/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(RecipeUpdateSchema),
  },
  {
    id: "recipe.delete",
    name: "anorvis_delete_recipe",
    label: "Delete Recipe",
    description: "Permanently delete a Health recipe from Anorvis OS.",
    domain: "health",
    operation: "delete",
    resource: "recipe",
    mutates: true,
    method: "DELETE",
    path: "/v1/health/recipes/:id",
    pathParams: ["id"],
    parameters: parametersFromSchema(IdSchema),
  },
  {
    id: "recipe.favorite",
    name: "anorvis_favorite_recipe",
    label: "Favorite Recipe",
    description: "Set the favorite state for a Health recipe.",
    domain: "health",
    operation: "update",
    resource: "recipe",
    mutates: true,
    method: "POST",
    path: "/v1/health/recipes/:id/favorite",
    pathParams: ["id"],
    parameters: parametersFromSchema(RecipeFavoriteSchema),
  },
  {
    id: "recipe_search.search",
    name: "anorvis_search_recipes",
    label: "Search External Recipes",
    description: "Search external recipe providers.",
    domain: "health",
    operation: "read",
    resource: "recipe_search",
    mutates: false,
    method: "GET",
    path: "/v1/integrations/recipes/search",
    queryParams: ["q"],
    parameters: parametersFromSchema(RecipeSearchSchema),
  },
  {
    id: "food_search.search",
    name: "anorvis_search_food",
    label: "Search Foods",
    description: "Search foods across local recipes and Open Food Facts.",
    domain: "health",
    operation: "read",
    resource: "food_search",
    mutates: false,
    method: "GET",
    path: "/v1/integrations/food/search",
    queryParams: ["q", "provider"],
    parameters: parametersFromSchema(FoodSearchSchema),
  },
  {
    id: "hevy_settings.read",
    name: "anorvis_read_hevy_settings",
    label: "Read Hevy Settings",
    description: "Read Hevy integration settings.",
    domain: "health",
    operation: "read",
    resource: "hevy_settings",
    mutates: false,
    method: "GET",
    path: "/v1/integrations/hevy/settings",
    parameters: EmptyParameters,
  },
  {
    id: "hevy_settings.update",
    name: "anorvis_update_hevy_settings",
    label: "Update Hevy Settings",
    description: "Save the Hevy API key for the integration.",
    domain: "health",
    operation: "update",
    resource: "hevy_settings",
    mutates: true,
    method: "POST",
    path: "/v1/integrations/hevy/settings",
    parameters: parametersFromSchema(HevySettingsSchema),
  },
  {
    id: "hevy_settings.disconnect",
    name: "anorvis_disconnect_hevy",
    label: "Disconnect Hevy",
    description: "Disconnect Hevy and remove its stored integration secret.",
    domain: "health",
    operation: "delete",
    resource: "hevy_settings",
    mutates: true,
    method: "POST",
    path: "/v1/integrations/hevy/disconnect",
    parameters: EmptyParameters,
  },
  {
    id: "hevy_sync.start",
    name: "anorvis_sync_hevy",
    label: "Sync Hevy",
    description: "Start a Hevy sync for workouts and body measurements.",
    domain: "health",
    operation: "start",
    resource: "hevy_sync",
    mutates: true,
    method: "POST",
    path: "/v1/integrations/hevy/sync",
    parameters: EmptyParameters,
  },
  {
    id: "hevy_routine.list",
    name: "anorvis_list_hevy_routines",
    label: "List Hevy Routines",
    description: "List Hevy routines from the connected account.",
    domain: "health",
    operation: "read",
    resource: "hevy_routine",
    mutates: false,
    method: "GET",
    path: "/v1/integrations/hevy/routines",
    parameters: EmptyParameters,
  },
  {
    id: "hevy_routine.create",
    name: "anorvis_create_hevy_routine",
    label: "Create Hevy Routine",
    description: "Create a new Hevy routine in the connected account.",
    domain: "health",
    operation: "create",
    resource: "hevy_routine",
    mutates: true,
    method: "POST",
    path: "/v1/integrations/hevy/routines",
    parameters: parametersFromSchema(HevyRoutineCreateSchema),
  },
  {
    id: "hevy_routine.update",
    name: "anorvis_update_hevy_routine",
    label: "Update Hevy Routine",
    description:
      "Update an existing Hevy routine. Routine creation is not supported by this route.",
    domain: "health",
    operation: "update",
    resource: "hevy_routine",
    mutates: true,
    method: "PUT",
    path: "/v1/integrations/hevy/routines/:routineId",
    pathParams: ["routineId"],
    parameters: parametersFromSchema(HevyRoutineUpdateSchema),
  },
  {
    id: "hevy_exercise_template.list",
    name: "anorvis_list_hevy_exercise_templates",
    label: "List Hevy Exercise Templates",
    description: "List Hevy exercise templates from the connected account.",
    domain: "health",
    operation: "read",
    resource: "hevy_exercise_template",
    mutates: false,
    method: "GET",
    path: "/v1/integrations/hevy/exercise-templates",
    parameters: EmptyParameters,
  },
] satisfies ToolkitTool[];
