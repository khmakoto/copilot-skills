import path from "node:path";
import { requireValue } from "../graph.mjs";
import { localProvider } from "./local.mjs";
import { githubProvider } from "./github.mjs";
import { adoProvider } from "./ado.mjs";

export function resolveProvider(url, explicit) {
  if (!url || explicit?.kind === "local") return { kind: "local" };
  let parsed;
  if (/^[^/@]+@[^:]+:/.test(url)) {
    const [, host, suffix] = /^[^/@]+@([^:]+):(.+)$/.exec(url);
    parsed = new URL(`ssh://${host}/${suffix}`);
  } else if (/^[a-z]+:\/\//i.test(url)) {
    parsed = new URL(url);
  } else {
    requireValue(!explicit || explicit.kind === "local", "A local remote cannot be a hosted provider.");
    return { kind: "local" };
  }
  const segments = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/").map(decodeURIComponent);
  if (parsed.hostname === "github.com" || explicit?.kind === "github") {
    requireValue(segments.length === 2, "Expected owner/repository remote.");
    return { kind: "github", host: parsed.host, owner: segments[0], repo: segments[1] };
  }
  if (parsed.hostname === "dev.azure.com") {
    requireValue(segments.length === 4 && segments[2] === "_git", "Invalid ADO remote.");
    return { kind: "ado", host: "dev.azure.com", organization: segments[0], project: segments[1], repo: segments[3] };
  }
  if (parsed.hostname.endsWith(".visualstudio.com")) {
    const projectPath = segments.length === 4 && segments[0] === "DefaultCollection"
      ? segments.slice(1) : segments;
    requireValue(projectPath.length === 3 && projectPath[1] === "_git", "Invalid ADO remote.");
    return { kind: "ado", host: "dev.azure.com", organization: parsed.hostname.split(".")[0], project: projectPath[0], repo: projectPath[2] };
  }
  if (parsed.hostname === "ssh.dev.azure.com") {
    requireValue(segments.length === 4 && segments[0] === "v3", "Invalid ADO SSH remote.");
    return { kind: "ado", host: "dev.azure.com", organization: segments[1], project: segments[2], repo: segments[3] };
  }
  if (parsed.protocol === "file:") return { kind: "local" };
  throw new Error("Unknown hosting provider. Specify provider.kind=github for GHES, or local explicitly.");
}

export function identity(url, provider, root) {
  if (provider.kind === "github") return `${provider.host.toLowerCase()}/${provider.owner}/${provider.repo}`;
  if (provider.kind === "ado") return `ado/${provider.organization}/${provider.project}/${provider.repo}`;
  return url ? `git/${/^[a-z]+:\/\//i.test(url) ? url : path.resolve(root, url)}` : `local/${root}`;
}

export function providerFor(config, cwd, runner) {
  if (config.kind === "github") return githubProvider(config, cwd, runner);
  if (config.kind === "ado") return adoProvider(config, cwd, runner);
  requireValue(config.kind === "local", "Unsupported provider.");
  return localProvider();
}
