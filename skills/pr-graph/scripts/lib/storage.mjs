import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { requireValue } from "./graph.mjs";

const FORMAT = "pr-graph-state";
const LIMIT = 4096;
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const address = (kind, bytes) => createHash("sha256").update(`${kind}\n`).update(bytes).digest("hex");
const report = (event, phase, details) => event?.({ phase, ...details });

function syncDirectory(dir, event) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
    report(event, "directory-synced", { file: dir });
  } catch (error) {
    const unsupported = ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code) ||
      (process.platform === "win32" && ["EPERM", "EISDIR"].includes(error.code));
    if (!unsupported) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function makeDirectory(dir, event) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (!first) return;
  let current = dir;
  while (true) {
    syncDirectory(current, event);
    if (current === path.dirname(first)) break;
    current = path.dirname(current);
  }
}

function atomicBytes(file, bytes, event) {
  makeDirectory(path.dirname(file), event);
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    report(event, "file-synced", { file, bytes: Buffer.byteLength(bytes) });
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  syncDirectory(path.dirname(file), event);
}

export function atomicJson(file, value) {
  atomicBytes(file, `${JSON.stringify(value, null, 2)}\n`);
}

function storageRoot(file) {
  const dir = path.dirname(file);
  const parent = path.basename(dir);
  const name = path.basename(file, ".json");
  if (path.extname(file) !== ".json") return null;
  if ((parent === "operations" && HEX.test(name)) || (parent === "graphs" && ID.test(name))) {
    return path.dirname(dir);
  }
  if (path.basename(path.dirname(dir)) === "history" && ID.test(parent) && HEX.test(name)) {
    return path.dirname(path.dirname(dir));
  }
  return null;
}

function blockFile(root, id) {
  requireValue(HEX.test(id), "Invalid retained payload address; preserve and inspect explicitly.");
  const dir = path.join(root, "payloads");
  const file = path.join(dir, id);
  for (const entry of [dir, file]) {
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    requireValue(!stat?.isSymbolicLink() && (!stat || (entry === dir ? stat.isDirectory() : stat.isFile())),
      `Unsafe retained payload path ${entry}; preserve and inspect explicitly.`);
  }
  return file;
}

function readBlock(root, kind, id, cache) {
  requireValue(["text", "tree"].includes(kind), "Unsupported retained payload kind.");
  const key = `${root}:${kind}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const file = blockFile(root, id);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`Cannot read retained payload ${file}: ${error.message}; preserve state and repair explicitly.`);
  }
  requireValue(address(kind, bytes) === id,
    `Corrupt retained payload ${file}; preserve state and repair explicitly.`);
  const text = bytes.toString("utf8");
  requireValue(Buffer.from(text).equals(bytes), `Invalid UTF-8 retained payload ${file}.`);
  cache.set(key, text);
  return text;
}

function decode(root, encoded, cache, active = new Set()) {
  requireValue(Array.isArray(encoded), "Invalid retained state encoding.");
  const [kind, value, id] = encoded;
  if (kind === "ref") {
    requireValue(encoded.length === 3 && typeof id === "string" && !active.has(id), "Invalid retained payload reference.");
    const text = readBlock(root, value, id, cache);
    if (value === "text") return text;
    active.add(id);
    try {
      return decode(root, JSON.parse(text), cache, active);
    } finally {
      active.delete(id);
    }
  }
  requireValue(encoded.length === 2, "Invalid retained state encoding.");
  if (kind === "value") {
    requireValue(value === null || ["string", "number", "boolean"].includes(typeof value), "Invalid retained scalar.");
    return value;
  }
  requireValue(Array.isArray(value), "Invalid retained state collection.");
  if (kind === "array") return value.map((v) => decode(root, v, cache, active));
  if (["array-parts", "object-parts"].includes(kind)) {
    requireValue(value.length > 0, "Invalid retained collection pages.");
    const parts = value.map((part) => decode(root, part, cache, active));
    if (kind === "array-parts") {
      requireValue(parts.every(Array.isArray), "Invalid retained array page.");
      return parts.flat();
    }
    requireValue(parts.every((part) => part && typeof part === "object" && !Array.isArray(part)),
      "Invalid retained object page.");
    const entries = parts.flatMap(Object.entries);
    requireValue(new Set(entries.map(([key]) => key)).size === entries.length, "Duplicate retained object page keys.");
    return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  requireValue(kind === "object", "Unsupported retained state encoding.");
  let previous;
  return Object.fromEntries(value.map((entry) => {
    requireValue(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" &&
      (previous === undefined || previous < entry[0]), "Invalid retained object keys.");
    previous = entry[0];
    return [entry[0], decode(root, entry[1], cache, active)];
  }));
}

export function readJson(file, optional = false, cache = new Map()) {
  if (optional && !fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const root = storageRoot(path.resolve(file));
    if (value?.format !== FORMAT) {
      requireValue(!root || !Object.hasOwn(value ?? {}, "format"), "Unsupported retained state format.");
      return value;
    }
    requireValue(root && value.version === 1 && Object.keys(value).sort().join(",") === "format,value,version",
      "Unsupported retained state envelope or location.");
    return decode(root, value.value, cache);
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}; preserve it and repair explicitly.`);
  }
}

export function storedJson(ctx, file, value) {
  const root = storageRoot(path.resolve(file));
  requireValue(root === path.resolve(ctx.dir), "Retained record must belong to this state directory.");
  readJson(file, true);
  const event = ctx.storageEvent;
  const blocks = new Map();
  const objects = new WeakMap();
  const texts = new Map();
  const keys = new Map();
  const put = (kind, bytes) => {
    const id = address(kind, bytes);
    const key = `${root}:${kind}:${id}`;
    if (!blocks.has(key)) {
      const target = blockFile(root, id);
      if (fs.existsSync(target)) readBlock(root, kind, id, blocks);
      else {
        report(event, "before-payload", { file: target, kind });
        atomicBytes(target, bytes, event);
        report(event, "after-payload", { file: target, kind });
      }
      blocks.set(key, bytes.toString("utf8"));
    }
    return ["ref", kind, id];
  };
  const serialize = (encoded) => {
    const bytes = JSON.stringify(encoded);
    report(event, "serialized", { bytes: Buffer.byteLength(bytes) });
    return bytes;
  };
  const finish = (encoded, top, force, bytes = serialize(encoded)) =>
    !top && (force || Buffer.byteLength(bytes) >= LIMIT) ? put("tree", Buffer.from(bytes)) : encoded;
  const collection = (kind, entries, top = false, force = false, depth = 0) => {
    const encoded = [kind, entries];
    const bytes = serialize(encoded);
    if (Buffer.byteLength(bytes) < LIMIT) return finish(encoded, top, force, bytes);
    if (kind === "object" && entries.length > 32 && depth < 128) {
      const buckets = Array.from({ length: 4 }, () => []);
      for (const entry of entries) {
        const key = entry[0];
        if (!keys.has(key)) keys.set(key, createHash("sha256").update(key).digest("hex"));
        const nibble = parseInt(keys.get(key)[Math.floor(depth / 2)], 16);
        buckets[(nibble >> (depth % 2 ? 0 : 2)) & 3].push(entry);
      }
      const groups = buckets.filter((bucket) => bucket.length);
      if (groups.length === 1) return collection(kind, entries, top, force, depth + 1);
      const parts = groups.map((group) => collection(kind, group, false, true, depth + 1));
      return finish(["object-parts", parts], top, force);
    }
    if (kind === "array" && entries.length > 16) {
      const chunks = (items) => Array.from({ length: Math.ceil(items.length / 16) }, (_, i) => items.slice(i * 16, (i + 1) * 16));
      let parts = chunks(entries).map((chunk) => collection(kind, chunk, false, true));
      while (parts.length > 16) parts = chunks(parts).map((chunk) => finish(["array-parts", chunk], false, true));
      return finish(["array-parts", parts], top, force);
    }
    return finish(encoded, top, force, bytes);
  };
  const encode = (v, top = false) => {
    if (typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) >= LIMIT) {
      if (!texts.has(v)) texts.set(v, put("text", Buffer.from(v)));
      return texts.get(v);
    }
    if (v === null || typeof v !== "object") return ["value", v ?? null];
    if (objects.has(v)) return objects.get(v);
    const result = Array.isArray(v) ? collection("array", Array.from(v, (item) => encode(item)), top) :
      collection("object", Object.keys(v).sort().filter((key) => v[key] !== undefined)
        .map((key) => [key, encode(v[key])]), top);
    objects.set(v, result);
    return result;
  };
  const encoded = encode(value, true);
  const bytes = `${JSON.stringify({ format: FORMAT, version: 1, value: encoded })}\n`;
  report(event, "serialized", { bytes: Buffer.byteLength(bytes) });
  if (blocks.size) {
    syncDirectory(path.join(root, "payloads"), event);
    syncDirectory(root, event);
  }
  report(event, "before-record", { file, value });
  atomicBytes(file, bytes, event);
  report(event, "after-record", { file, value });
}
