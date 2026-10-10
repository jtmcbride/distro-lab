import { canonicalJson, type CanonicalValue, type ScenarioAction } from "@distro-lab/core";

/** One-line description of a scenario action, e.g. "crash B" or "partition A,B | C,D,E". */
export function describeAction({ action: a }: ScenarioAction): string {
  switch (a.type) {
    case "crash":
    case "recover":
      return `${a.type} ${a.node}`;
    case "timeout":
      return `fire ${a.node}'s ${a.key} timer`;
    case "client":
      return `${a.node}: ${canonicalJson(a.command as CanonicalValue)}`;
    case "network": {
      const c = a.change;
      switch (c.type) {
        case "partition":
          return `partition ${c.groups.map((g) => g.join(",")).join(" | ")}`;
        case "isolate":
          return `isolate ${c.node}`;
        case "heal":
        case "restore":
          return `network ${c.type}`;
        case "setAll": {
          const { type: _t, ...settings } = c;
          return `all links ${canonicalJson(settings)}`;
        }
        case "setLink": {
          const { type: _t, from, to, bidirectional, ...settings } = c;
          return `link ${from}${bidirectional === true ? "↔" : "→"}${to} ${canonicalJson(settings)}`;
        }
      }
    }
  }
}

/** Faults (everything except client traffic). */
export const isFault = (a: ScenarioAction) => a.action.type !== "client";
