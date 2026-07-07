import { listInvalidationEvents } from "../../data";
import { corsHeaders, type RouteHandler } from "../http";

export function eventRoutes(): RouteHandler {
  return (request, url) => {
    if (request.method === "GET" && url.pathname === "/v1/events") return eventStream(request, url);
    return undefined;
  };
}

function eventStream(request: Request, url: URL): Response {
  const cursor = url.searchParams.get("lastEventId") ?? request.headers.get("last-event-id") ?? "0";
  const parsedCursor = Number(cursor);
  let lastId = Number.isFinite(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;
  const encoder = new TextEncoder();
  let interval: Timer | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const flush = () => {
        const events = listInvalidationEvents(lastId);
        for (const event of events) {
          lastId = event.id;
          send(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      };
      flush();
      interval = setInterval(() => {
        flush();
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
    },
    cancel() {
      clearInterval(interval);
    },
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
