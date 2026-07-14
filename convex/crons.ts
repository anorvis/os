import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "synchronize connected providers",
  { hours: 6 },
  internal.maintenance.enqueueProviderSyncs,
);

crons.interval(
  "remove expired OAuth states",
  { hours: 1 },
  internal.maintenance.cleanupOAuthStates,
);

export default crons;
