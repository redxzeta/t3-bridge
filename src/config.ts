import { readFileSync } from "node:fs";
import { z } from "zod";

const upstreamSchema = z.object({
  name: z.string().regex(/^[a-z](?:[a-z0-9]|_(?!_)){0,29}[a-z0-9]$|^[a-z]$/),
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname === "/mcp"
      && !url.username && !url.password && !/[?#]/.test(value);
  }, "upstream URL must be an HTTP or HTTPS /mcp URL without credentials, query, or fragment"),
});

const configSchema = z.object({
  publicUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !/[?#]/.test(value) && !url.username && !url.password;
  }, "publicUrl must be an HTTPS origin"),
  listenPort: z.number().int().min(1024).max(65535),
  ownerEmail: z.email(),
  upstreams: z.array(upstreamSchema).min(1).max(8),
}).superRefine((config, ctx) => {
  const names = config.upstreams.map((item) => item.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: "custom", message: "upstream names must be unique", path: ["upstreams"] });
  }
});

export type BridgeConfig = z.infer<typeof configSchema>;
export type UpstreamConfig = BridgeConfig["upstreams"][number];

export function loadConfig(path: string): BridgeConfig {
  const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return { ...config, publicUrl: new URL(config.publicUrl).origin };
}
