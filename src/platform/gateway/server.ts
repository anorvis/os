import { createServer } from "./app";

const { server } = createServer();

console.log(`anorvis-os listening on port ${server.port}`);
