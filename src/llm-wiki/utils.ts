import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function isInside(rootDir: string, target: string): boolean {
  const root = resolve(rootDir);
  const path = resolve(target);
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function assertRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\0")) throw new Error(`Invalid path: ${path}`);
  if (path.split(/[\\/]+/).includes("..")) throw new Error(`Path traversal is not allowed: ${path}`);
}

export function listMarkdownFiles(rootDir: string, subdir: string): string[] {
  const start = resolve(rootDir, subdir);
  if (!existsSync(start)) return [];
  const out: string[] = [];
  walk(start, out, rootDir);
  return out.sort();
}

function walk(dir: string, out: string[], rootDir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = resolve(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(path, out, rootDir);
    else if (stat.isFile() && name.endsWith(".md")) out.push(toPosix(relative(rootDir, path)));
  }
}

export type Frontmatter = Record<string, string | string[]>;

export function parseFrontmatter(markdown: string): { frontmatter: Frontmatter; body: string } {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end).trim().split("\n");
  const frontmatter: Frontmatter = {};
  for (const line of raw) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value === "[]") frontmatter[key] = [];
    else if (value.startsWith("[") && value.endsWith("]")) frontmatter[key] = value.slice(1, -1).split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
    else frontmatter[key] = stripQuotes(value);
  }
  return { frontmatter, body: markdown.slice(end + 5).replace(/^\n/, "") };
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function readMarkdown(rootDir: string, relPath: string): string {
  assertRelativePath(relPath);
  const path = resolve(rootDir, relPath);
  if (!isInside(rootDir, path)) throw new Error(`Path outside LLM Wiki: ${relPath}`);
  return readFileSync(path, "utf8");
}

export function titleFromMarkdown(markdown: string, fallback: string): string {
  const { frontmatter, body } = parseFrontmatter(markdown);
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === "string" && fmTitle.trim()) return fmTitle.trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

export function extractWikiLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1]?.trim()).filter((v): v is string => Boolean(v));
}

export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "note";
}

export function firstParagraph(markdown: string): string {
  const { body } = parseFrontmatter(markdown);
  return body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"))?.replace(/\s+/g, " ").slice(0, 240) ?? "";
}
