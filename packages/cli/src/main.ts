#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  clientHistory,
  DEFAULT_HISTORY_FORMAT,
  defaultRegistry,
  formatRecord,
  relativeTo,
  fuzz,
  runScenario,
  scenarioForSeed,
  type HistoryFormat,
  type RunResult,
  type Scenario,
  type TraceRecord,
} from "@distro-lab/core";

const USAGE = `Usage: sim <command> [options]

Commands:
  list                         List protocols and planted-bug variants
  gen  --seed N [--protocol P] Print the scenario generated from a seed
  example <name> [--protocol P]
                               Print a hand-written scenario (e.g. figure8)
  run  <scenario.json>         Run a scenario and report violations
       [--trace] [--tail N]    Print the whole trace, or the last N records up to
                               the first violation
       [--state]               Print every process's final state
       [--history] [--key K]   Print client operations per key, up to the first
                               violation (only the failing operation's key, if any)
  fuzz [--protocol P]          Run generated scenarios and report failures
       [--seeds N] [--first S] [--nodes 3,5] [--max-failures K]
       [--out DIR] [--no-minimize]

Every scenario is reproducible: the same JSON always produces the same trace hash.`;

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const nodeIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

function int(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be an integer, got "${value}"`);
  return n;
}

function describeFailure(r: RunResult): string[] {
  const lines = r.violations
    .slice(0, 5)
    .map((v) => `  SAFETY ${v.invariant} at ${v.t}ms (record #${v.recordId}): ${v.message}`);
  if (r.violations.length > 5) lines.push(`  ... ${r.violations.length - 5} more violations`);
  for (const l of r.liveness) lines.push(`  LIVENESS ${l}`);
  return lines;
}

/**
 * Client operations grouped by key, up to the first violation. If that violation is at an
 * operation's completion, only its key is shown (unless `key` is given), and every other
 * operation is marked by its real-time order relative to it.
 */
function printHistory(io: Io, r: RunResult, format: HistoryFormat, key: string | undefined): void {
  const firstBad = r.violations[0]?.recordId ?? Infinity;
  const ops = clientHistory((r.trace ?? []).filter((rec: TraceRecord) => rec.id <= firstBad));
  const failing = ops.find((op) => op.completeRecord === firstBad);
  const keys = [...new Set(ops.map((op) => format.partition(op.input)))].sort();
  const shown =
    key !== undefined ? [key] : failing !== undefined ? [format.partition(failing.input)] : keys;
  const time = (t: number | null) => (t === null ? "pending" : t.toFixed(3)).padStart(10);
  for (const k of shown) {
    const mine = ops.filter((op) => format.partition(op.input) === k);
    const scope = r.violations.length > 0 ? ", up to the first violation" : "";
    io.out(`history of ${k === "" ? "(no key)" : k}${scope}: ${mine.length} operations`);
    io.out(
      `  ${failing === undefined ? "" : "        "}${"invoked".padStart(10)} ${"completed".padStart(10)}  op      operation                    result`,
    );
    for (const op of mine) {
      const mark =
        failing === undefined
          ? ""
          : op === failing
            ? "FAILED  "
            : relativeTo(op, failing) === "before"
              ? "before  "
              : "overlaps";
      const result = op.output === null ? "?" : format.describeOutput(op.output);
      io.out(
        `  ${mark}${time(op.invokedAt)} ${time(op.completedAt)}  ${op.id.padEnd(7)} ${format.describeInput(op.input).padEnd(28)} ${result}`,
      );
    }
  }
}

/** Runs the CLI; returns the process exit code (0 ok, 1 failure found, 2 usage error). */
export function main(argv: readonly string[], io: Io = nodeIo): number {
  const [command, ...rest] = argv;
  const registry = defaultRegistry();
  try {
    switch (command) {
      case "list": {
        for (const e of registry.values()) io.out(`${e.name.padEnd(28)} ${e.description}`);
        return 0;
      }

      case "gen": {
        const { values } = parseArgs({
          args: rest,
          options: { seed: { type: "string" }, protocol: { type: "string", default: "raft" } },
        });
        if (!registry.has(values.protocol)) {
          throw new UsageError(`unknown protocol "${values.protocol}"`);
        }
        const scenario = scenarioForSeed(registry, int(values.seed, "seed", 0), {
          protocol: values.protocol,
        });
        io.out(JSON.stringify(scenario, null, 2));
        return 0;
      }

      case "example": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { protocol: { type: "string", default: "raft" } },
        });
        const entry = registry.get(values.protocol);
        if (entry === undefined) throw new UsageError(`unknown protocol "${values.protocol}"`);
        const name = positionals[0];
        const make = name === undefined ? undefined : entry.examples?.[name];
        if (make === undefined) {
          const known = Object.keys(entry.examples ?? {}).join(", ") || "none";
          throw new UsageError(`unknown example "${name ?? ""}" (available: ${known})`);
        }
        io.out(JSON.stringify(make(values.protocol), null, 2));
        return 0;
      }

      case "run": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            trace: { type: "boolean", default: false },
            tail: { type: "string" },
            state: { type: "boolean", default: false },
            history: { type: "boolean", default: false },
            key: { type: "string" },
          },
        });
        const file = positionals[0];
        if (file === undefined) throw new UsageError("run needs a scenario file");
        const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
        const tail = values.tail === undefined ? undefined : int(values.tail, "tail", 0);
        const r = runScenario(registry, scenario, {
          keepTrace: values.trace || tail !== undefined || values.history,
          keepState: values.state,
        });
        if (r.trace !== undefined && (values.trace || tail !== undefined)) {
          const firstBad = r.violations[0]?.recordId ?? Infinity;
          const upTo = r.trace.filter((rec) => rec.id <= firstBad);
          const shown = tail === undefined ? r.trace : upTo.slice(-tail);
          for (const rec of shown) io.out(formatRecord(rec));
        }
        if (values.history) {
          const format = registry.get(scenario.protocol)?.history ?? DEFAULT_HISTORY_FORMAT;
          printHistory(io, r, format, values.key);
        }
        if (r.finalState !== undefined) {
          const format = registry.get(scenario.protocol)?.formatView;
          for (const p of r.finalState) {
            const view =
              p.role === "server" && format !== undefined ? format(p.view) : JSON.stringify(p.view);
            io.out(`${p.id.padEnd(4)} ${p.up ? "up  " : "DOWN"} ${view}`);
          }
        }
        io.out(
          `protocol=${scenario.protocol} seed=${scenario.seed} events=${r.events} trace=${r.traceHash}`,
        );
        const problems = describeFailure(r);
        if (problems.length === 0) {
          io.out("OK: no violations");
          return 0;
        }
        io.out("FAILED:");
        problems.forEach((l) => io.out(l));
        return 1;
      }

      case "fuzz": {
        const { values } = parseArgs({
          args: rest,
          options: {
            protocol: { type: "string", default: "raft" },
            seeds: { type: "string" },
            first: { type: "string" },
            nodes: { type: "string" },
            "max-failures": { type: "string" },
            out: { type: "string" },
            "no-minimize": { type: "boolean", default: false },
          },
        });
        if (!registry.has(values.protocol))
          throw new UsageError(`unknown protocol "${values.protocol}"`);
        const seeds = int(values.seeds, "seeds", 1000);
        const started = Date.now();
        const report = fuzz(registry, {
          protocol: values.protocol,
          seeds,
          firstSeed: int(values.first, "first", 0),
          maxFailures: int(values["max-failures"], "max-failures", 1),
          minimize: !values["no-minimize"],
          ...(values.nodes === undefined
            ? {}
            : { clusterSizes: values.nodes.split(",").map((n) => int(n, "nodes", 0)) }),
          onProgress: (done, failures) => {
            if (done % 500 === 0) io.err(`  ${done}/${seeds} runs, ${failures} failing`);
          },
        });
        const secs = (Date.now() - started) / 1000;
        io.out(
          `${report.runs} runs, ${report.events} events in ${secs.toFixed(1)}s ` +
            `(${Math.round(report.events / Math.max(secs, 0.001))} events/s), ${report.failures.length} failing`,
        );
        for (const f of report.failures) {
          const seed = f.result.scenario.seed;
          io.out(`seed ${seed}:`);
          describeFailure(f.result).forEach((l) => io.out(l));
          io.out(
            `  minimized: ${f.result.scenario.actions.length} -> ${f.minimized.actions.length} actions`,
          );
          if (values.out !== undefined) {
            mkdirSync(values.out, { recursive: true });
            const base = join(values.out, `${values.protocol}-seed${seed}`);
            writeFileSync(`${base}.json`, `${JSON.stringify(f.result.scenario, null, 2)}\n`);
            writeFileSync(`${base}.min.json`, `${JSON.stringify(f.minimized, null, 2)}\n`);
            io.out(`  wrote ${base}.json and ${base}.min.json`);
          }
        }
        return report.failures.length === 0 ? 0 : 1;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return command === undefined ? 2 : 0;

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    const usage =
      e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    io.err(`error: ${(e as Error).message}`);
    if (usage) io.err(USAGE);
    return 2;
  }
}

class UsageError extends Error {}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
