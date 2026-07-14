import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { httpAction } from "../../_generated/server";

export const serveAttachment = httpAction(async (ctx, request) => {
  const id = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  if (!id) return new Response("Not found", { status: 404 });
  try {
    const attachment = await ctx.runQuery(internal.capability.wiki.attachmentForDelivery, {
      attachmentId: id as Id<"wikiAttachments">,
    });
    if (attachment === null) return new Response("Not found", { status: 404 });
    const blob = await ctx.storage.get(attachment.storageId);
    if (blob === null) return new Response("Not found", { status: 404 });
    const mimeType = attachment.mimeType.toLowerCase().split(";")[0].trim();
    const inline =
      mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      mimeType === "application/pdf" ||
      (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") ||
      mimeType.startsWith("audio/") ||
      mimeType.startsWith("video/");
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
      "Content-Type": inline ? mimeType : "application/octet-stream",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) return new Response("Invalid range", { status: 416 });
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= blob.size) {
        return new Response("Invalid range", {
          status: 416,
          headers: { "Content-Range": `bytes */${blob.size}` },
        });
      }
      headers.set("Content-Length", String(end - start + 1));
      headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
      return new Response(blob.slice(start, end + 1).stream(), { status: 206, headers });
    }
    headers.set("Content-Length", String(blob.size));
    return new Response(blob.stream(), { status: 200, headers });
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
});
