import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const taskStatus = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("cancelled"),
);

const taskPriority = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("urgent"),
);

const source = v.union(
  v.literal("manual"),
  v.literal("agent"),
  v.literal("import"),
  v.literal("google"),
  v.literal("pinterest"),
  v.literal("hevy"),
  v.literal("snaptrade"),
  v.literal("csv"),
  v.literal("url"),
  v.literal("themealdb"),
);

const jobStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelling"),
  v.literal("cancelled"),
);

const decimal = v.object({
  units: v.int64(),
  scale: v.number(),
});

const providerStatus = v.union(
  v.literal("available"),
  v.literal("pending"),
  v.literal("connected"),
  v.literal("error"),
  v.literal("disabled"),
);

const encryptedCredentials = v.optional(
  v.object({
    algorithm: v.literal("aes-256-gcm"),
    keyVersion: v.number(),
    nonce: v.string(),
    ciphertext: v.string(),
  }),
);
const contextEventKind = v.union(
  v.literal("conversation_turn"),
  v.literal("integration_update"),
  v.literal("agent_action"),
  v.literal("context_note"),
);

const contextSurface = v.union(
  v.literal("pi"),
  v.literal("discord"),
  v.literal("web"),
  v.literal("sms"),
  v.literal("integration"),
  v.literal("system"),
);

const contextVisibility = v.union(v.literal("private"), v.literal("shared"));

const contextEventSource = v.object({
  surface: contextSurface,
  principalId: v.optional(v.string()),
  conversationId: v.string(),
  visibility: contextVisibility,
  workspaceId: v.optional(v.string()),
  channelId: v.optional(v.string()),
  threadId: v.optional(v.string()),
});

const contextEventContent = v.object({
  text: v.optional(v.string()),
  prompt: v.optional(v.string()),
  assistant: v.optional(v.any()),
  toolResults: v.optional(v.any()),
  resource: v.optional(v.string()),
  resourceId: v.optional(v.string()),
  attachments: v.optional(v.array(v.object({
    id: v.string(),
    name: v.string(),
    mediaType: v.optional(v.string()),
    url: v.optional(v.string()),
  }))),
});


const contextClaimStatus = v.union(
  v.literal("claimed"),
  v.literal("acked"),
);

const contextOutboundStatus = v.union(
  v.literal("queued"),
  v.literal("claimed"),
  v.literal("completed"),
  v.literal("failed"),
);

const contextAttachment = v.object({
  id: v.string(),
  name: v.string(),
  mediaType: v.optional(v.string()),
  url: v.optional(v.string()),
});

const contextDestination = v.object({
  surface: contextSurface,
  channelId: v.string(),
  threadId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
});

const schema = defineSchema({
  ...authTables,

  workspaces: defineTable({
    name: v.string(),
    slug: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("member")),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  userPreferences: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    unitSystem: v.union(v.literal("metric"), v.literal("imperial")),
    reportingCurrency: v.union(
      v.literal("CAD"),
      v.literal("USD"),
      v.literal("BTC"),
    ),
    inspiration: v.optional(
      v.object({
        boardUrl: v.string(),
        cadenceMinutes: v.number(),
        imageUrls: v.array(v.string()),
      }),
    ),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  tasks: defineTable({
    workspaceId: v.id("workspaces"),
    title: v.string(),
    notes: v.optional(v.string()),
    status: taskStatus,
    priority: v.optional(taskPriority),
    dueAt: v.optional(v.number()),
    source,
    sourceId: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    links: v.array(v.string()),
    multiSession: v.boolean(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_status_due", ["workspaceId", "status", "dueAt"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"]),

  taskSessions: defineTable({
    workspaceId: v.id("workspaces"),
    taskId: v.id("tasks"),
    startAt: v.number(),
    endAt: v.number(),
    status: v.union(
      v.literal("planned"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    source,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_workspace_start", ["workspaceId", "startAt"])
    .index("by_workspace_status_start", ["workspaceId", "status", "startAt"]),

  calendarEvents: defineTable({
    workspaceId: v.id("workspaces"),
    summary: v.string(),
    schedule: v.union(
      v.object({
        kind: v.literal("timed"),
        startAt: v.number(),
        endAt: v.number(),
        timezone: v.optional(v.string()),
      }),
      v.object({
        kind: v.literal("all_day"),
        startDate: v.string(),
        endDateExclusive: v.string(),
      }),
    ),
    startDay: v.string(),
    endDay: v.string(),
    location: v.optional(v.string()),
    description: v.optional(v.string()),
    tag: v.optional(v.string()),
    source,
    readOnly: v.boolean(),
    provider: v.string(),
    providerEventId: v.optional(v.string()),
    calendarId: v.optional(v.string()),
    sourceHash: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_start_day", ["workspaceId", "startDay"])
    .index("by_workspace_end_day", ["workspaceId", "endDay"])
    .index("by_workspace_provider_event", [
      "workspaceId",
      "provider",
      "providerEventId",
    ])
    .index("by_workspace_provider_calendar_event", [
      "workspaceId",
      "provider",
      "calendarId",
      "providerEventId",
    ])
    .index("by_workspace_calendar_start", ["workspaceId", "calendarId", "startDay"]),

  lifeTags: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    normalizedName: v.string(),
    color: v.optional(v.string()),
    hidden: v.boolean(),
    systemKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_name", ["workspaceId", "normalizedName"])
    .index("by_workspace_system", ["workspaceId", "systemKey"]),

  meals: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    mealType: v.string(),
    loggedAt: v.number(),
    calories: v.number(),
    proteinGrams: v.number(),
    carbsGrams: v.number(),
    fatGrams: v.number(),
    source,
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_logged", ["workspaceId", "loggedAt"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"]),

  macroProfiles: defineTable({
    workspaceId: v.id("workspaces"),
    active: v.boolean(),
    birthdate: v.optional(v.string()),
    heightCm: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    bodyFatPercent: v.optional(v.number()),
    sex: v.optional(v.string()),
    goal: v.optional(v.string()),
    trainingDaysPerWeek: v.optional(v.number()),
    activityLevel: v.optional(v.string()),
    targetCalories: v.optional(v.number()),
    proteinGrams: v.optional(v.number()),
    carbsGrams: v.optional(v.number()),
    fatGrams: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_active", ["workspaceId", "active"]),

  bodyMeasurements: defineTable({
    workspaceId: v.id("workspaces"),
    source,
    sourceId: v.optional(v.string()),
    recordedAt: v.number(),
    weightKg: v.optional(v.number()),
    leanMassKg: v.optional(v.number()),
    fatPercent: v.optional(v.number()),
    neckCm: v.optional(v.number()),
    shoulderCm: v.optional(v.number()),
    chestCm: v.optional(v.number()),
    leftBicepCm: v.optional(v.number()),
    rightBicepCm: v.optional(v.number()),
    leftForearmCm: v.optional(v.number()),
    rightForearmCm: v.optional(v.number()),
    abdomenCm: v.optional(v.number()),
    waistCm: v.optional(v.number()),
    hipsCm: v.optional(v.number()),
    leftThighCm: v.optional(v.number()),
    rightThighCm: v.optional(v.number()),
    leftCalfCm: v.optional(v.number()),
    rightCalfCm: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_recorded", ["workspaceId", "recordedAt"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"]),

  workouts: defineTable({
    workspaceId: v.id("workspaces"),
    source,
    sourceId: v.optional(v.string()),
    title: v.string(),
    startedAt: v.number(),
    durationSeconds: v.number(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_started", ["workspaceId", "startedAt"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"]),

  workoutExercises: defineTable({
    workspaceId: v.id("workspaces"),
    workoutId: v.id("workouts"),
    title: v.string(),
    muscleGroups: v.array(v.string()),
    order: v.number(),
  }).index("by_workout_order", ["workoutId", "order"]),

  exerciseSets: defineTable({
    workspaceId: v.id("workspaces"),
    workoutId: v.id("workouts"),
    workoutExerciseId: v.id("workoutExercises"),
    setType: v.string(),
    reps: v.optional(v.number()),
    weightKg: v.optional(v.number()),
    durationSeconds: v.optional(v.number()),
    distanceMeters: v.optional(v.number()),
    order: v.number(),
  })
    .index("by_exercise_order", ["workoutExerciseId", "order"])
    .index("by_workout", ["workoutId"]),

  workoutTemplates: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_updated", ["workspaceId", "updatedAt"]),

  workoutTemplateExercises: defineTable({
    workspaceId: v.id("workspaces"),
    templateId: v.id("workoutTemplates"),
    title: v.string(),
    order: v.number(),
  }).index("by_template_order", ["templateId", "order"]),

  workoutTemplateSets: defineTable({
    workspaceId: v.id("workspaces"),
    templateId: v.id("workoutTemplates"),
    exerciseId: v.id("workoutTemplateExercises"),
    weightKg: v.optional(v.number()),
    reps: v.optional(v.number()),
    order: v.number(),
  })
    .index("by_exercise_order", ["exerciseId", "order"])
    .index("by_template", ["templateId"]),

  recipes: defineTable({
    workspaceId: v.id("workspaces"),
    title: v.string(),
    source,
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
    favorite: v.boolean(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_favorite", ["workspaceId", "favorite"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["workspaceId"],
    }),

  recipeIngredients: defineTable({
    workspaceId: v.id("workspaces"),
    recipeId: v.id("recipes"),
    name: v.string(),
    quantity: v.optional(v.string()),
    order: v.number(),
  }).index("by_recipe_order", ["recipeId", "order"]),

  recipeInstructions: defineTable({
    workspaceId: v.id("workspaces"),
    recipeId: v.id("recipes"),
    text: v.string(),
    order: v.number(),
  }).index("by_recipe_order", ["recipeId", "order"]),

  financeCategories: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    normalizedName: v.string(),
    group: v.string(),
    excludeFromSpending: v.boolean(),
    color: v.optional(v.string()),
  }).index("by_workspace_name", ["workspaceId", "normalizedName"]),

  financeAccounts: defineTable({
    workspaceId: v.id("workspaces"),
    source,
    sourceId: v.optional(v.string()),
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    name: v.string(),
    institution: v.optional(v.string()),
    mask: v.optional(v.string()),
    type: v.string(),
    currency: v.string(),
    balance: v.optional(decimal),
    status: v.union(v.literal("active"), v.literal("hidden"), v.literal("closed")),
    observedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"])
    .index("by_workspace_type", ["workspaceId", "type"]),

  financeImportJobs: defineTable({
    workspaceId: v.id("workspaces"),
    source,
    sourceVariant: v.optional(v.string()),
    accountId: v.optional(v.id("financeAccounts")),
    storageId: v.optional(v.id("_storage")),
    mapping: v.optional(
      v.object({
        dateColumn: v.string(),
        descriptionColumn: v.string(),
        amountColumn: v.string(),
        currencyColumn: v.optional(v.string()),
        categoryColumn: v.optional(v.string()),
        defaultCurrency: v.string(),
      }),
    ),
    status: jobStatus,
    cursor: v.optional(v.string()),
    checkpoint: v.optional(v.string()),
    idempotencyKey: v.string(),
    fetchedCount: v.number(),
    appliedCount: v.number(),
    skippedCount: v.number(),
    attempt: v.number(),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"]),

  financeBalances: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("financeAccounts"),
    currency: v.string(),
    cash: v.optional(decimal),
    buyingPower: v.optional(decimal),
    observedAt: v.number(),
    source,
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_currency", ["accountId", "currency"])
    .index("by_workspace_observed", ["workspaceId", "observedAt"]),

  financeTransactions: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("financeAccounts")),
    source,
    sourceId: v.optional(v.string()),
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    fingerprint: v.string(),
    dedupeKey: v.optional(v.string()),
    description: v.string(),
    amount: decimal,
    currency: v.string(),
    postedAt: v.number(),
    categoryId: v.optional(v.id("financeCategories")),
    status: v.string(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_posted", ["workspaceId", "postedAt"])
    .index("by_account_posted", ["accountId", "postedAt"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"])
    .index("by_workspace_source_fingerprint", ["workspaceId", "source", "fingerprint"])
    .index("by_workspace_dedupe", ["workspaceId", "dedupeKey"]),

  financePositions: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("financeAccounts"),
    source,
    sourceId: v.optional(v.string()),
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    symbol: v.string(),
    name: v.optional(v.string()),
    quantity: decimal,
    marketValue: v.optional(decimal),
    averageCost: v.optional(decimal),
    currency: v.string(),
    observedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_account_symbol", ["accountId", "symbol"])
    .index("by_account_source_id", ["accountId", "source", "sourceId"])
    .index("by_workspace_source_id", ["workspaceId", "source", "sourceId"]),

  financeActivities: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("financeAccounts")),
    source,
    sourceId: v.optional(v.string()),
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    type: v.string(),
    description: v.optional(v.string()),
    amount: v.optional(decimal),
    currency: v.string(),
    symbol: v.optional(v.string()),
    quantity: v.optional(decimal),
    price: v.optional(decimal),
    fingerprint: v.string(),
    status: v.string(),
    occurredAt: v.number(),
    settledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_occurred", ["workspaceId", "occurredAt"])
    .index("by_account_occurred", ["accountId", "occurredAt"])
    .index("by_workspace_source_fingerprint", ["workspaceId", "source", "fingerprint"]),

  financeAccountValueHistory: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("financeAccounts"),
    source,
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    date: v.string(),
    equity: decimal,
    cash: v.optional(decimal),
    currency: v.string(),
    observedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_date", ["accountId", "date"])
    .index("by_workspace_date", ["workspaceId", "date"]),

  financeAccountReturnRates: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("financeAccounts"),
    source,
    sourceVariant: v.optional(v.string()),
    importJobId: v.optional(v.id("financeImportJobs")),
    timeframe: v.string(),
    returnPercent: v.number(),
    asOf: v.optional(v.string()),
    observedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_account_timeframe", ["accountId", "timeframe"]),

  financeAccountLinks: defineTable({
    workspaceId: v.id("workspaces"),
    accountId: v.id("financeAccounts"),
    canonicalAccountId: v.id("financeAccounts"),
    method: v.union(v.literal("manual"), v.literal("automatic")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_canonical", ["canonicalAccountId"])
    .index("by_workspace", ["workspaceId"]),

  providerConnections: defineTable(
    v.union(
      v.object({
        workspaceId: v.id("workspaces"),
        provider: v.literal("google"),
        status: providerStatus,
        scopes: v.array(v.string()),
        accessTokenExpiresAt: v.optional(v.number()),
        credentials: encryptedCredentials,
        connectedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
      v.object({
        workspaceId: v.id("workspaces"),
        provider: v.literal("pinterest"),
        status: providerStatus,
        scopes: v.array(v.string()),
        accessTokenExpiresAt: v.optional(v.number()),
        credentials: encryptedCredentials,
        connectedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
      v.object({
        workspaceId: v.id("workspaces"),
        provider: v.literal("hevy"),
        status: providerStatus,
        credentials: encryptedCredentials,
        connectedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
      v.object({
        workspaceId: v.id("workspaces"),
        provider: v.literal("snaptrade"),
        status: providerStatus,
        lastCheckedAt: v.optional(v.number()),
        credentials: encryptedCredentials,
        connectedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
    ),
  ).index("by_workspace_provider", ["workspaceId", "provider"]),

  oauthStates: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.union(v.literal("google"), v.literal("pinterest")),
    stateHash: v.string(),
    redirectUri: v.string(),
    returnTo: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_state_hash", ["stateHash"])
    .index("by_workspace_expires", ["workspaceId", "expiresAt"]),

  syncJobs: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.string(),
    kind: v.string(),
    status: jobStatus,
    cursor: v.optional(v.string()),
    checkpoint: v.optional(v.string()),
    fetchedCount: v.number(),
    appliedCount: v.number(),
    skippedCount: v.number(),
    attempt: v.number(),
    lease: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_provider_status", ["workspaceId", "provider", "status"])
    .index("by_workspace_provider_kind_status", [
      "workspaceId",
      "provider",
      "kind",
      "status",
    ]),
  providerSyncStates: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.union(
      v.literal("google"),
      v.literal("hevy"),
      v.literal("snaptrade"),
    ),
    sequence: v.number(),
    lastSyncedAt: v.optional(v.number()),
    watermark: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_provider", ["workspaceId", "provider"])
    .index("by_provider", ["provider"]),

  wikiPages: defineTable({
    workspaceId: v.id("workspaces"),
    path: v.string(),
    title: v.string(),
    aliases: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    currentRevisionId: v.optional(v.id("wikiRevisions")),
    revisionNumber: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("archived"),
      v.literal("deleted"),
    ),
    visibility: v.optional(contextVisibility),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_workspace_status_updated", ["workspaceId", "status", "updatedAt"])
    .index("by_workspace_status_visibility_updated", [
      "workspaceId",
      "status",
      "visibility",
      "updatedAt",
    ])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"]),

  wikiPageAliases: defineTable({
    workspaceId: v.id("workspaces"),
    path: v.string(),
    pageId: v.id("wikiPages"),
    createdAt: v.number(),
  })
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_page", ["pageId"]),

  wikiRevisions: defineTable({
    workspaceId: v.id("workspaces"),
    pageId: v.id("wikiPages"),
    revisionNumber: v.number(),
    parentRevisionId: v.optional(v.id("wikiRevisions")),
    markdown: v.string(),
    contentHash: v.string(),
    authorKind: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("import"),
      v.literal("system"),
    ),
    authorUserId: v.optional(v.id("users")),
    agentRunId: v.optional(v.id("wikiAgentRuns")),
    summary: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_page_revision", ["pageId", "revisionNumber"])
    .index("by_page_created", ["pageId", "createdAt"]),

  wikiSearchDocuments: defineTable({
    workspaceId: v.id("workspaces"),
    pageId: v.id("wikiPages"),
    currentRevisionId: v.id("wikiRevisions"),
    path: v.string(),
    title: v.string(),
    aliases: v.array(v.string()),
    tags: v.array(v.string()),
    markdown: v.string(),
    searchText: v.string(),
    contentHash: v.string(),
    status: v.optional(
      v.union(v.literal("active"), v.literal("archived"), v.literal("deleted")),
    ),
    updatedAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .searchIndex("search_content", {
      searchField: "searchText",
      filterFields: ["workspaceId", "status"],
    }),

  wikiLinks: defineTable({
    workspaceId: v.id("workspaces"),
    pageId: v.id("wikiPages"),
    revisionId: v.id("wikiRevisions"),
    targetPageId: v.optional(v.id("wikiPages")),
    targetPath: v.string(),
    label: v.optional(v.string()),
    kind: v.union(
      v.literal("wiki"),
      v.literal("markdown"),
      v.literal("embed"),
    ),
  })
    .index("by_page", ["pageId"])
    .index("by_target_page", ["targetPageId"])
    .index("by_workspace_target_path", ["workspaceId", "targetPath"]),

  wikiSources: defineTable({
    workspaceId: v.id("workspaces"),
    kind: v.union(
      v.literal("interaction"),
      v.literal("upload"),
      v.literal("url"),
      v.literal("directory_import"),
      v.literal("provider"),
      v.literal("agent_research"),
    ),
    title: v.string(),
    origin: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    extractedText: v.optional(v.string()),
    contentHash: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("indexed"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_hash", ["workspaceId", "contentHash"]),

  wikiChunks: defineTable({
    workspaceId: v.id("workspaces"),
    pageId: v.optional(v.id("wikiPages")),
    sourceId: v.optional(v.id("wikiSources")),
    revisionId: v.optional(v.id("wikiRevisions")),
    ordinal: v.number(),
    headingPath: v.array(v.string()),
    text: v.string(),
    contentHash: v.string(),
    embedding: v.optional(v.array(v.float64())),
    embeddingState: v.optional(
      v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    ),
    embeddingModel: v.optional(v.string()),
    embeddingVersion: v.optional(v.string()),
    embeddingError: v.optional(v.string()),
  })
    .index("by_page", ["pageId"])
    .index("by_source", ["sourceId"])
    .index("by_source_ordinal", ["sourceId", "ordinal"])
    .index("by_revision", ["revisionId"])
    .index("by_workspace_embedding_state", ["workspaceId", "embeddingState"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
      filterFields: ["workspaceId"],
    }),

  wikiAttachments: defineTable({
    workspaceId: v.id("workspaces"),
    pageId: v.optional(v.id("wikiPages")),
    sourceId: v.optional(v.id("wikiSources")),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    contentHash: v.string(),
    sensitivity: v.union(v.literal("private"), v.literal("shareable")),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_page_hash", ["pageId", "contentHash"])
    .index("by_source", ["sourceId"])
    .index("by_source_hash", ["sourceId", "contentHash"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_hash", ["workspaceId", "contentHash"]),

  wikiAgentRuns: defineTable({
    workspaceId: v.id("workspaces"),
    kind: v.union(
      v.literal("orient"),
      v.literal("research"),
      v.literal("compile"),
      v.literal("interaction_memory"),
      v.literal("maintenance"),
    ),
    task: v.string(),
    status: jobStatus,
    model: v.optional(v.string()),
    allowWeb: v.boolean(),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_status", ["workspaceId", "status"]),

  contextEvents: defineTable({
    id: v.string(),
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    kind: contextEventKind,
    occurredAt: v.number(),
    source: contextEventSource,
    content: contextEventContent,
    createdAt: v.number(),
  })
    .index("by_event_id", ["id"])
    .index("by_workspace_occurred", ["workspaceId", "occurredAt"])
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_surface_created", [
      "workspaceId",
      "source.surface",
      "createdAt",
    ])
    .index("by_workspace_kind_created", [
      "workspaceId",
      "kind",
      "createdAt",
    ])
    .index("by_workspace_surface_kind_created", [
      "workspaceId",
      "source.surface",
      "kind",
      "createdAt",
    ])
    .index("by_workspace_visibility_occurred", [
      "workspaceId",
      "source.visibility",
      "occurredAt",
    ])
    .index("by_workspace_owner_occurred", [
      "workspaceId",
      "ownerId",
      "occurredAt",
    ])
    .index("by_workspace_visibility_channel_occurred", [
      "workspaceId",
      "source.visibility",
      "source.channelId",
      "occurredAt",
    ]),
  contextSummaries: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    scopeKind: v.union(
      v.literal("owner"),
      v.literal("workspace"),
      v.literal("channel"),
    ),
    scopeId: v.string(),
    visibility: contextVisibility,
    channelId: v.optional(v.string()),
    summary: v.string(),
    updatedAt: v.number(),
  })
    .index("by_scope", ["workspaceId", "scopeKind", "scopeId"])
    .index("by_workspace_updated", ["workspaceId", "updatedAt"])
    .index("by_workspace_visibility_updated", [
      "workspaceId",
      "visibility",
      "updatedAt",
    ])
    .index("by_workspace_owner_updated", [
      "workspaceId",
      "ownerId",
      "updatedAt",
    ])
    .index("by_workspace_visibility_channel_updated", [
      "workspaceId",
      "visibility",
      "channelId",
      "updatedAt",
    ]),

  contextConsumers: defineTable({
    workspaceId: v.id("workspaces"),
    consumer: v.string(),
    surface: v.optional(contextSurface),
    kind: v.optional(contextEventKind),
    // `cursor` is retained for rows written by the original occurredAt-based
    // scanner. New scans persist their creation-order position separately.
    cursor: v.number(),
    cursorCreatedAt: v.optional(v.number()),
    // Built-in Convex pagination cursor for creation-order scans.
    // Legacy cursor/cursorCreatedAt/cursorEventId rows remain readable.
    scanCursor: v.optional(v.string()),
    cursorEventId: v.optional(v.id("contextEvents")),
    scopeKind: v.optional(
      v.union(
        v.literal("owner"),
        v.literal("workspace"),
        v.literal("channel"),
      ),
    ),
    scopeId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_workspace_consumer", ["workspaceId", "consumer"])
    .index("by_workspace_consumer_scope", [
      "workspaceId",
      "consumer",
      "scopeKind",
      "scopeId",
    ])
    .index("by_workspace_consumer_surface_scope", [
      "workspaceId",
      "consumer",
      "surface",
      "scopeKind",
      "scopeId",
    ])
    .index("by_workspace_consumer_kind_scope", [
      "workspaceId",
      "consumer",
      "kind",
      "scopeKind",
      "scopeId",
    ])
    .index("by_workspace_consumer_surface_kind_scope", [
      "workspaceId",
      "consumer",
      "surface",
      "kind",
      "scopeKind",
      "scopeId",
    ]),
  contextEventClaims: defineTable({
    workspaceId: v.id("workspaces"),
    eventId: v.id("contextEvents"),
    consumer: v.string(),
    status: contextClaimStatus,
    claimToken: v.string(),
    batchId: v.optional(v.string()),
    leaseUntil: v.number(),
    attempts: v.number(),
    claimedAt: v.number(),
    ackedAt: v.optional(v.number()),
  })
    .index("by_event_consumer", ["eventId", "consumer"])
    .index("by_workspace_consumer", ["workspaceId", "consumer"])
    .index("by_workspace_consumer_status", [
      "workspaceId",
      "consumer",
      "status",
    ])
    .index("by_workspace_consumer_batch", ["workspaceId", "consumer", "batchId"]),

  contextOutboundMessages: defineTable({
    id: v.string(),
    workspaceId: v.id("workspaces"),
    ownerId: v.id("users"),
    destination: contextDestination,
    text: v.string(),
    attachments: v.optional(v.array(contextAttachment)),
    replyToId: v.optional(v.string()),
    status: contextOutboundStatus,
    attempts: v.number(),
    nextAttemptAt: v.number(),
    claimToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_outbound_id", ["id"])
    .index("by_workspace_status_attempt", [
      "workspaceId",
      "status",
      "nextAttemptAt",
    ])
    .index("by_workspace_owner_status_attempt", [
      "workspaceId",
      "ownerId",
      "status",
      "nextAttemptAt",
    ])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),
  contextMonitorEffects: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.optional(v.id("users")),
    effectKey: v.string(),
    consumer: v.string(),
    jobConsumer: v.optional(v.string()),
    kind: v.union(v.literal("summary"), v.literal("wiki"), v.literal("notification")),
    eventIds: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("needs_reconciliation"),
    ),
    payload: v.any(),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    jobClaimToken: v.optional(v.string()),
    jobLeaseUntil: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_workspace_effect_key", ["workspaceId", "effectKey"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_owner_status", ["workspaceId", "ownerId", "status"]),
  contextMonitorPlans: defineTable({
    workspaceId: v.id("workspaces"),
    ownerId: v.optional(v.id("users")),
    consumer: v.string(),
    planKey: v.string(),
    batchId: v.string(),
    result: v.object({
      summaries: v.array(v.object({
        conversationId: v.string(),
        visibility: v.union(v.literal("private"), v.literal("shared")),
        channelId: v.optional(v.string()),
        summary: v.string(),
      })),
      wikiTasks: v.array(v.object({ task: v.string() })),
      notifications: v.array(v.object({ text: v.string(), reason: v.string() })),
      notes: v.string(),
    }),
    createdAt: v.number(),
  })
    .index("by_workspace_consumer_plan", ["workspaceId", "consumer", "planKey"])
    .index("by_workspace_consumer_batch", ["workspaceId", "consumer", "batchId"]),
});

export default schema;
