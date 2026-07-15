import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "synchronize connected providers",
  { hours: 6 },
  internal.capability.integration.jobs.enqueueProviderSyncs,
);

crons.interval(
  "synchronize connected Hevy workout events",
  { seconds: 30 },
  internal.capability.integration.jobs.enqueueLiveHevySyncs,
);

crons.interval(
  "remove expired OAuth states",
  { hours: 1 },
  internal.capability.integration.jobs.cleanupOAuthStates,
);

export default crons;
