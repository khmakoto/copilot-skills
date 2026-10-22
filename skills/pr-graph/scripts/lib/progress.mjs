import { performance } from "node:perf_hooks";
import { topological } from "./graph.mjs";

let sink;
let sequence = 0;

export function setProgressSink(value) {
  sink = value;
}

export function nodeDetails(graph, node) {
  const nodes = topological(graph).filter((n) => !n.retired);
  return { node, index: nodes.findIndex((n) => n.id === node.id) + 1, total: nodes.length };
}

export function step(label, action, details = {}) {
  if (!sink) return action();
  const scopes = (Array.isArray(details) ? details : [details]).map((value) => ({ ...value, id: ++sequence }));
  const started = performance.now();
  const emit = (type) => {
    for (const scope of scopes) sink({
      type, id: scope.id, label, elapsed: performance.now() - started,
      outcome: scope.success ?? "done",
      ...(scope.node ? {
        node: scope.node.id, branch: scope.node.branch,
        pr: scope.node.pr?.url ?? scope.node.pr?.id,
        index: scope.index, total: scope.total,
      } : {}),
    });
  };
  emit("start");
  try {
    const result = action();
    emit("done");
    return result;
  } catch (error) {
    emit("failed");
    throw error;
  }
}

function duration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const clean = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export class ProgressReporter {
  constructor({ stream = process.stderr, now = () => performance.now(), heartbeatMs = 120_000 } = {}) {
    this.stream = stream;
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.active = new Map();
    this.lastEvent = now();
    this.rich = Boolean(stream.isTTY) && process.env.TERM !== "dumb";
    this.color = this.rich && !Object.hasOwn(process.env, "NO_COLOR");
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), this.rich ? 100 : 1000);
    this.timer.unref();
  }

  text(event) {
    const node = event.node
      ? `${event.index ? `[${event.index}/${event.total}] ` : ""}${event.node} | ${event.branch}${event.pr ? ` | ${event.pr}` : ""} | `
      : "";
    return clean(`${node}${event.label}`);
  }

  clear() {
    if (this.rich) this.stream.write("\r\x1b[2K");
  }

  line(text, color = "36") {
    this.clear();
    this.stream.write(`${this.color ? `\x1b[${color}m${text}\x1b[0m` : text}\n`);
  }

  receive(event) {
    this.lastEvent = this.now();
    if (event.type === "start") {
      this.active.set(event.id, { ...event, received: this.lastEvent });
      this.line(`${this.text(event)}: started`);
    } else {
      this.active.delete(event.id);
      this.line(`${this.text(event)}: ${event.type === "done" ? event.outcome ?? "done" : "failed"} (${duration(event.elapsed)})`,
        event.type === "done" ? "32" : "31");
    }
  }

  tick() {
    const current = [...this.active.values()].at(-1);
    if (!current) return;
    const now = this.now();
    const elapsed = duration(now - current.received);
    if (now - this.lastEvent >= this.heartbeatMs) {
      this.line(`${this.text(current)}: still running (${elapsed} elapsed)`);
      this.lastEvent = now;
    }
    if (this.rich) {
      const text = `${"|/-\\"[this.frame++ % 4]} ${this.text(current)} (${elapsed})`;
      const width = this.stream.columns ?? 80;
      this.clear();
      this.stream.write(text.slice(0, Math.max(0, width - 1)));
    }
  }

  close() {
    clearInterval(this.timer);
    this.clear();
    this.active.clear();
  }
}
