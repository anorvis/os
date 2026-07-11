import { createSnapTradeAutoSync } from "../../capability/finance/snaptrade-auto-sync";
import { createServer } from "./app";

const { server } = createServer();
createSnapTradeAutoSync().start();

console.log(`anorvis-os listening on port ${server.port}`);
