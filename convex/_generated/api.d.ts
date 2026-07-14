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
import type * as calendar from "../calendar.js";
import type * as crons from "../crons.js";
import type * as finance from "../finance.js";
import type * as financeDashboard from "../financeDashboard.js";
import type * as financeImport from "../financeImport.js";
import type * as foodProviders from "../foodProviders.js";
import type * as google from "../google.js";
import type * as health from "../health.js";
import type * as healthSearch from "../healthSearch.js";
import type * as hevy from "../hevy.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as legacyImport from "../legacyImport.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_credentials from "../lib/credentials.js";
import type * as lib_decimal from "../lib/decimal.js";
import type * as life from "../life.js";
import type * as maintenance from "../maintenance.js";
import type * as pinterest from "../pinterest.js";
import type * as providerJobs from "../providerJobs.js";
import type * as recipeImport from "../recipeImport.js";
import type * as recipes from "../recipes.js";
import type * as snaptrade from "../snaptrade.js";
import type * as tasks from "../tasks.js";
import type * as wiki from "../wiki.js";
import type * as wikiFiles from "../wikiFiles.js";
import type * as wikiHttp from "../wikiHttp.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  calendar: typeof calendar;
  crons: typeof crons;
  finance: typeof finance;
  financeDashboard: typeof financeDashboard;
  financeImport: typeof financeImport;
  foodProviders: typeof foodProviders;
  google: typeof google;
  health: typeof health;
  healthSearch: typeof healthSearch;
  hevy: typeof hevy;
  http: typeof http;
  integrations: typeof integrations;
  legacyImport: typeof legacyImport;
  "lib/auth": typeof lib_auth;
  "lib/credentials": typeof lib_credentials;
  "lib/decimal": typeof lib_decimal;
  life: typeof life;
  maintenance: typeof maintenance;
  pinterest: typeof pinterest;
  providerJobs: typeof providerJobs;
  recipeImport: typeof recipeImport;
  recipes: typeof recipes;
  snaptrade: typeof snaptrade;
  tasks: typeof tasks;
  wiki: typeof wiki;
  wikiFiles: typeof wikiFiles;
  wikiHttp: typeof wikiHttp;
  workspaces: typeof workspaces;
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
