import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabaseForTests } from "../src/core/db/database";
import { createApp } from "../src/platform/gateway/app";
import { toolkitManifest } from "../src/platform/toolkit/manifest";

const financeToolNames = [
  "anorvis_read_finance_dashboard",
  "anorvis_list_finance_accounts",
  "anorvis_create_finance_account",
  "anorvis_update_finance_account",
  "anorvis_delete_finance_account",
  "anorvis_import_finance_csv",
  "anorvis_undo_finance_import",
] as const;

const healthToolNames = [
  "anorvis_read_health_dashboard",
  "anorvis_list_meals",
  "anorvis_create_meal",
  "anorvis_update_meal",
  "anorvis_delete_meal",
  "anorvis_update_macro_profile",
  "anorvis_read_macro_profile",
  "anorvis_create_workout",
  "anorvis_update_workout",
  "anorvis_list_body_measurements",
  "anorvis_list_workouts",
  "anorvis_list_recipes",
  "anorvis_create_recipe",
  "anorvis_update_recipe",
  "anorvis_delete_recipe",
  "anorvis_favorite_recipe",
  "anorvis_import_recipe",
  "anorvis_search_recipes",
  "anorvis_search_food",
  "anorvis_read_hevy_settings",
  "anorvis_update_hevy_settings",
  "anorvis_sync_hevy",
  "anorvis_disconnect_hevy",
  "anorvis_list_hevy_routines",
  "anorvis_create_hevy_routine",
  "anorvis_update_hevy_routine",
  "anorvis_list_hevy_exercise_templates",
] as const;
function captureEnvironment(
  ...keys: string[]
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(
  environment: Map<string, string | undefined>,
): void {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function toolsByName<T extends { name: string }>(
  tools: T[],
): Record<string, T> {
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

function propertiesOf(tool: {
  parameters: { properties?: unknown };
}): Record<string, Record<string, unknown>> {
  return (tool.parameters.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
}

function requiredOf(tool: { parameters: { required?: unknown } }): string[] {
  return Array.isArray(tool.parameters.required)
    ? (tool.parameters.required as string[])
    : [];
}

function expectStrictObjectParameters(tool: {
  parameters: Record<string, unknown>;
}): void {
  expect(tool.parameters).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
}

describe("platform toolkit", () => {
  test("exposes curated agent tools", async () => {
    const environment = captureEnvironment(
      "HOME",
      "ANORVIS_DB_PATH",
      "ANORVIS_OS_API_TOKEN",
      "ANORVIS_SECRET_PROVIDER",
    );
    const home = mkdtempSync(join(tmpdir(), "anorvis-toolkit-"));
    process.env.HOME = home;
    process.env.ANORVIS_DB_PATH = join(home, "data.sqlite");
    process.env.ANORVIS_SECRET_PROVIDER = "local";
    delete process.env.ANORVIS_OS_API_TOKEN;
    resetDatabaseForTests();
    try {
      const response = await createApp().request("/v1/os/toolkit");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        version: number;
        tools: Array<{
          name: string;
          operation: string;
          resource: string;
          parameters: Record<string, unknown>;
        }>;
      };
      expect(body.version).toBe(1);
      const toolNames = body.tools.map((tool) => tool.name);
      expect(toolNames).toContain("anorvis_create_task");
      expect(toolNames).toContain("anorvis_list_calendar_events");
      for (const name of financeToolNames) expect(toolNames).toContain(name);
      for (const tool of body.tools) {
        expect(tool.name.startsWith("anorvis_life_")).toBe(false);
        expect(tool.name.includes("upsert")).toBe(false);
        expect(typeof tool.operation).toBe("string");
        expect(typeof tool.resource).toBe("string");
        expect(tool.parameters).toMatchObject({
          type: "object",
          additionalProperties: false,
        });
      }
    } finally {
      resetDatabaseForTests();
      restoreEnvironment(environment);
    }
  });

  test("manifest has unique tool names and described fields", () => {
    const tools = toolkitManifest().tools;
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of financeToolNames) expect(names).toContain(name);

    const createTask = tools.find(
      (tool) => tool.name === "anorvis_create_task",
    );
    const taskProperties = createTask?.parameters.properties as
      Record<string, Record<string, unknown>> | undefined;
    expect(taskProperties?.dueAt?.description).toContain("ISO");

    const financeByName = Object.fromEntries(
      tools
        .filter((tool) =>
          financeToolNames.includes(
            tool.name as (typeof financeToolNames)[number],
          ),
        )
        .map((tool) => [tool.name, tool]),
    ) as Record<(typeof financeToolNames)[number], (typeof tools)[number]>;
    expect(financeByName.anorvis_read_finance_dashboard.mutates).toBe(false);
    expect(financeByName.anorvis_list_finance_accounts.mutates).toBe(false);
    expect(financeByName.anorvis_create_finance_account.mutates).toBe(true);
    expect(financeByName.anorvis_update_finance_account.mutates).toBe(true);
    expect(financeByName.anorvis_delete_finance_account.mutates).toBe(true);
    expect(financeByName.anorvis_import_finance_csv.mutates).toBe(true);
    expect(financeByName.anorvis_undo_finance_import.mutates).toBe(true);

    for (const name of financeToolNames) {
      expect(financeByName[name].parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }

    const dashboardProperties = financeByName.anorvis_read_finance_dashboard
      .parameters.properties as
      Record<string, Record<string, unknown>> | undefined;
    expect(
      financeByName.anorvis_read_finance_dashboard.parameters.required,
    ).toContain("currency");
    expect(dashboardProperties?.currency?.description).toContain("Required");

    const listProperties = financeByName.anorvis_list_finance_accounts
      .parameters.properties as
      Record<string, Record<string, unknown>> | undefined;
    expect(
      financeByName.anorvis_list_finance_accounts.parameters.required,
    ).toContain("currency");
    expect(listProperties?.currency?.description).toContain("Required");

    const updateProperties = financeByName.anorvis_update_finance_account
      .parameters.properties as
      Record<string, Record<string, unknown>> | undefined;
    expect(
      financeByName.anorvis_update_finance_account.parameters.required,
    ).toContain("accountId");
    expect(updateProperties?.accountId?.description).toContain("account id");

    const importProperties = financeByName.anorvis_import_finance_csv.parameters
      .properties as Record<string, Record<string, unknown>> | undefined;
    expect(
      financeByName.anorvis_import_finance_csv.parameters.required,
    ).toContain("accountId");
    expect(importProperties?.accountId?.description).toContain("account id");

    const undoProperties = financeByName.anorvis_undo_finance_import.parameters
      .properties as Record<string, Record<string, unknown>> | undefined;
    expect(
      financeByName.anorvis_undo_finance_import.parameters.required,
    ).toContain("importId");
    expect(undoProperties?.importId?.description).toContain("import id");
  });

  test("manifest exposes the Health toolkit contract", () => {
    const tools = toolkitManifest().tools;
    const byName = toolsByName(tools);
    const names = tools.map((tool) => tool.name);

    for (const name of healthToolNames) expect(names).toContain(name);
    expect(names).not.toContain("anorvis_delete_workout");
    expect(names).not.toContain("anorvis_delete_body_measurement");

    for (const name of healthToolNames) {
      const tool = byName[name];
      expect(tool.domain).toBe("health");
      expectStrictObjectParameters(tool);
    }

    expect(byName.anorvis_read_health_dashboard).toMatchObject({
      operation: "read",
      resource: "health_dashboard",
      mutates: false,
      method: "GET",
      path: "/v1/health/dashboard",
    });
    expect(byName.anorvis_read_health_dashboard.parameters.required).toEqual(
      [],
    );

    expect(byName.anorvis_list_meals).toMatchObject({
      operation: "read",
      resource: "meal",
      mutates: false,
      method: "GET",
      path: "/v1/health/dashboard",
    });

    expect(byName.anorvis_create_meal).toMatchObject({
      operation: "create",
      resource: "meal",
      mutates: true,
      method: "POST",
      path: "/v1/health/meals",
    });
    for (const field of ["name", "mealType", "loggedAt"]) {
      expect(requiredOf(byName.anorvis_create_meal)).toContain(field);
    }

    expect(byName.anorvis_update_meal).toMatchObject({
      operation: "update",
      resource: "meal",
      mutates: true,
      method: "PUT",
      path: "/v1/health/meals/:id",
      pathParams: ["id"],
    });
    for (const field of ["id", "name", "mealType", "loggedAt"]) {
      expect(requiredOf(byName.anorvis_update_meal)).toContain(field);
    }

    expect(byName.anorvis_delete_meal).toMatchObject({
      operation: "delete",
      resource: "meal",
      mutates: true,
      method: "DELETE",
      path: "/v1/health/meals/:id",
      pathParams: ["id"],
    });
    expect(requiredOf(byName.anorvis_delete_meal)).toEqual(["id"]);

    expect(byName.anorvis_read_macro_profile).toMatchObject({
      operation: "read",
      resource: "macro_profile",
      mutates: false,
      method: "GET",
      path: "/v1/health/dashboard",
    });

    expect(byName.anorvis_update_macro_profile).toMatchObject({
      operation: "update",
      resource: "macro_profile",
      mutates: true,
      method: "POST",
      path: "/v1/health/macro-profile",
    });
    for (const field of ["heightCm", "weightKg", "activityLevel"]) {
      expect(requiredOf(byName.anorvis_update_macro_profile)).toContain(field);
    }

    expect(byName.anorvis_list_workouts).toMatchObject({
      operation: "read",
      resource: "workout",
      mutates: false,
      method: "GET",
      path: "/v1/health/dashboard",
    });

    expect(byName.anorvis_create_workout).toMatchObject({
      operation: "create",
      resource: "workout",
      mutates: true,
      method: "POST",
      path: "/v1/health/workouts",
    });
    for (const field of ["title", "startedAt"]) {
      expect(requiredOf(byName.anorvis_create_workout)).toContain(field);
    }

    expect(byName.anorvis_update_workout).toMatchObject({
      operation: "update",
      resource: "workout",
      mutates: true,
      method: "PUT",
      path: "/v1/health/workouts/:id",
      pathParams: ["id"],
    });
    for (const field of ["id", "title", "startedAt"]) {
      expect(requiredOf(byName.anorvis_update_workout)).toContain(field);
    }

    expect(byName.anorvis_list_body_measurements).toMatchObject({
      operation: "read",
      resource: "body_measurement",
      mutates: false,
      method: "GET",
      path: "/v1/health/dashboard",
    });

    expect(byName.anorvis_list_recipes).toMatchObject({
      operation: "read",
      resource: "recipe",
      mutates: false,
      method: "GET",
      path: "/v1/health/recipes",
    });
    expect(byName.anorvis_create_recipe).toMatchObject({
      operation: "create",
      resource: "recipe",
      mutates: true,
      method: "POST",
      path: "/v1/health/recipes",
    });
    expect(byName.anorvis_update_recipe).toMatchObject({
      operation: "update",
      resource: "recipe",
      mutates: true,
      method: "PUT",
      path: "/v1/health/recipes/:id",
      pathParams: ["id"],
    });
    expect(byName.anorvis_delete_recipe).toMatchObject({
      operation: "delete",
      resource: "recipe",
      mutates: true,
      method: "DELETE",
      path: "/v1/health/recipes/:id",
      pathParams: ["id"],
    });

    expect(byName.anorvis_favorite_recipe).toMatchObject({
      operation: "update",
      resource: "recipe",
      mutates: true,
      method: "POST",
      path: "/v1/health/recipes/:id/favorite",
      pathParams: ["id"],
    });
    expect(requiredOf(byName.anorvis_favorite_recipe)).toEqual([
      "id",
      "isFavorite",
    ]);

    expect(byName.anorvis_import_recipe).toMatchObject({
      operation: "create",
      resource: "recipe_import",
      mutates: true,
      method: "POST",
      path: "/v1/health/recipes/import",
    });
    expect(requiredOf(byName.anorvis_import_recipe)).toEqual(["url"]);
    expect(
      propertiesOf(byName.anorvis_import_recipe).url.description,
    ).toContain("URL");

    expect(byName.anorvis_search_recipes).toMatchObject({
      operation: "read",
      resource: "recipe_search",
      mutates: false,
      method: "GET",
      path: "/v1/integrations/recipes/search",
      queryParams: ["q"],
    });
    expect(requiredOf(byName.anorvis_search_recipes)).toEqual(["q"]);

    expect(byName.anorvis_search_food).toMatchObject({
      operation: "read",
      resource: "food_search",
      mutates: false,
      method: "GET",
      path: "/v1/integrations/food/search",
      queryParams: ["q", "provider"],
    });
    expect(requiredOf(byName.anorvis_search_food)).toContain("q");
    expect(
      propertiesOf(byName.anorvis_search_food).provider.description,
    ).toContain("provider");

    expect(byName.anorvis_read_hevy_settings).toMatchObject({
      operation: "read",
      resource: "hevy_settings",
      mutates: false,
      method: "GET",
      path: "/v1/integrations/hevy/settings",
    });
    expect(byName.anorvis_update_hevy_settings).toMatchObject({
      operation: "update",
      resource: "hevy_settings",
      mutates: true,
      method: "POST",
      path: "/v1/integrations/hevy/settings",
    });
    expect(requiredOf(byName.anorvis_update_hevy_settings)).toContain("apiKey");

    expect(byName.anorvis_disconnect_hevy).toMatchObject({
      operation: "delete",
      resource: "hevy_settings",
      mutates: true,
      method: "POST",
      path: "/v1/integrations/hevy/disconnect",
    });

    expect(byName.anorvis_sync_hevy).toMatchObject({
      operation: "start",
      resource: "hevy_sync",
      mutates: true,
      method: "POST",
      path: "/v1/integrations/hevy/sync",
    });
    expect(byName.anorvis_list_hevy_routines).toMatchObject({
      operation: "read",
      resource: "hevy_routine",
      mutates: false,
      method: "GET",
      path: "/v1/integrations/hevy/routines",
    });
    expect(byName.anorvis_create_hevy_routine).toMatchObject({
      operation: "create",
      resource: "hevy_routine",
      mutates: true,
      method: "POST",
      path: "/v1/integrations/hevy/routines",
    });
    for (const field of ["title", "exercises"]) {
      expect(requiredOf(byName.anorvis_create_hevy_routine)).toContain(field);
    }

    expect(byName.anorvis_update_hevy_routine).toMatchObject({
      operation: "update",
      resource: "hevy_routine",
      mutates: true,
      method: "PUT",
      path: "/v1/integrations/hevy/routines/:routineId",
      pathParams: ["routineId"],
    });
    expect(requiredOf(byName.anorvis_update_hevy_routine)).toContain(
      "routineId",
    );
    expect(byName.anorvis_list_hevy_exercise_templates).toMatchObject({
      operation: "read",
      resource: "hevy_exercise_template",
      mutates: false,
      method: "GET",
      path: "/v1/integrations/hevy/exercise-templates",
    });
  });
});
