/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as capability_calendar from "../capability/calendar.js";
import type * as capability_context from "../capability/context.js";
import type * as capability_finance from "../capability/finance.js";
import type * as capability_finance_decimal from "../capability/finance/decimal.js";
import type * as capability_finance_import from "../capability/finance/import.js";
import type * as capability_finance_snaptrade from "../capability/finance/snaptrade.js";
import type * as capability_health from "../capability/health.js";
import type * as capability_health_recipes from "../capability/health/recipes.js";
import type * as capability_health_search from "../capability/health/search.js";
import type * as capability_integration from "../capability/integration.js";
import type * as capability_integration_food from "../capability/integration/food.js";
import type * as capability_integration_google from "../capability/integration/google.js";
import type * as capability_integration_hevy from "../capability/integration/hevy.js";
import type * as capability_integration_jobs from "../capability/integration/jobs.js";
import type * as capability_integration_pinterest from "../capability/integration/pinterest.js";
import type * as capability_integration_rateLimit from "../capability/integration/rateLimit.js";
import type * as capability_integration_recipeImport from "../capability/integration/recipeImport.js";
import type * as capability_integration_runner from "../capability/integration/runner.js";
import type * as capability_life from "../capability/life.js";
import type * as capability_task from "../capability/task.js";
import type * as capability_wiki from "../capability/wiki.js";
import type * as capability_wiki_files from "../capability/wiki/files.js";
import type * as capability_wiki_http from "../capability/wiki/http.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as platform_auth_access from "../platform/auth/access.js";
import type * as platform_auth_credentials from "../platform/auth/credentials.js";
import type * as platform_migration_legacyImport from "../platform/migration/legacyImport.js";
import type * as platform_workspace from "../platform/workspace.js";
import type * as product_web_finance from "../product/web/finance.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "capability/calendar": typeof capability_calendar;
  "capability/context": typeof capability_context;
  "capability/finance": typeof capability_finance;
  "capability/finance/decimal": typeof capability_finance_decimal;
  "capability/finance/import": typeof capability_finance_import;
  "capability/finance/snaptrade": typeof capability_finance_snaptrade;
  "capability/health": typeof capability_health;
  "capability/health/recipes": typeof capability_health_recipes;
  "capability/health/search": typeof capability_health_search;
  "capability/integration": typeof capability_integration;
  "capability/integration/food": typeof capability_integration_food;
  "capability/integration/google": typeof capability_integration_google;
  "capability/integration/hevy": typeof capability_integration_hevy;
  "capability/integration/jobs": typeof capability_integration_jobs;
  "capability/integration/pinterest": typeof capability_integration_pinterest;
  "capability/integration/rateLimit": typeof capability_integration_rateLimit;
  "capability/integration/recipeImport": typeof capability_integration_recipeImport;
  "capability/integration/runner": typeof capability_integration_runner;
  "capability/life": typeof capability_life;
  "capability/task": typeof capability_task;
  "capability/wiki": typeof capability_wiki;
  "capability/wiki/files": typeof capability_wiki_files;
  "capability/wiki/http": typeof capability_wiki_http;
  crons: typeof crons;
  http: typeof http;
  "platform/auth/access": typeof platform_auth_access;
  "platform/auth/credentials": typeof platform_auth_credentials;
  "platform/migration/legacyImport": typeof platform_migration_legacyImport;
  "platform/workspace": typeof platform_workspace;
  "product/web/finance": typeof product_web_finance;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
