import { createServer } from "./app";

const running = createServer();
console.log(`anorvis-os listening on port ${running.server.port}`);
void running.ready;

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running.stop();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
