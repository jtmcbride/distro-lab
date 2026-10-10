import { useEffect, useRef, useState } from "react";
import type { Scenario } from "@distro-lab/core";
import { registry, SCENARIO_CHOICES } from "../scenarios.ts";
import { decodeScenario, downloadJson, encodeScenario, HASH_PREFIX } from "../share.ts";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { scenarioForSeed } from "@distro-lab/core";

/** Load examples, generate from a seed, import/export JSON, and share links. */
export function ScenarioMenu() {
  const [choice, setChoice] = useState("");
  const [protocol, setProtocol] = useState("raft");
  const [seed, setSeed] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadedName = useSim((s) => s.scenarioName);

  const load = (s: Scenario, name: string, jump = false) => {
    sim.load(s, name, { jumpToViolation: jump });
    setNotice(null);
  };

  useEffect(() => {
    // A share link wins over the default scenario.
    const hash = window.location.hash;
    if (hash.startsWith(HASH_PREFIX)) {
      decodeScenario(hash.slice(HASH_PREFIX.length))
        .then((s) => load(s, "Shared scenario", true))
        .catch(() => {
          setNotice("That share link could not be read.");
          load(SCENARIO_CHOICES[0]!.make(), SCENARIO_CHOICES[0]!.label);
        });
    } else {
      load(SCENARIO_CHOICES[0]!.make(), SCENARIO_CHOICES[0]!.label);
    }
  }, []);

  return (
    <div className="scenario-menu">
      <label>
        Scenario
        <select
          value={choice}
          onChange={(e) => {
            const c = SCENARIO_CHOICES.find((x) => x.id === e.target.value);
            if (c !== undefined) load(c.make(), c.label);
            setChoice("");
          }}
          aria-label="Load an example scenario"
        >
          <option value="">{loadedName}</option>
          {SCENARIO_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <details className="popover">
        <summary>Generate…</summary>
        <div className="popover-body">
          <label className="field">
            Protocol
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {[...registry.values()].map((p) => (
                <option key={p.name} value={p.name} title={p.description}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Seed
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number.parseInt(e.target.value, 10) || 0)}
            />
          </label>
          <button
            type="button"
            onClick={(e) => {
              load(scenarioForSeed(registry, seed, { protocol }), `${protocol}, seed ${seed}`);
              (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
            }}
          >
            Load generated scenario
          </button>
          <p className="muted small">
            The same scenario `sim fuzz` runs for this seed: random faults and client traffic.
          </p>
        </div>
      </details>
      <button type="button" onClick={() => fileRef.current?.click()}>
        Import
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file === undefined) return;
          try {
            load(JSON.parse(await file.text()) as Scenario, file.name, true);
          } catch {
            setNotice(`${file.name} is not a scenario file.`);
          }
        }}
      />
      <button
        type="button"
        onClick={async () => downloadJson("scenario.json", await sim.exportScenario())}
      >
        Export
      </button>
      <button
        type="button"
        onClick={async () => {
          const url = `${location.origin}${location.pathname}${HASH_PREFIX}${await encodeScenario(await sim.exportScenario())}`;
          history.replaceState(null, "", url);
          try {
            await navigator.clipboard.writeText(url);
            setNotice("Link copied: it replays this session exactly.");
          } catch {
            setNotice("Link is in the address bar: it replays this session exactly.");
          }
        }}
      >
        Share link
      </button>
      {notice !== null && <span className="notice">{notice}</span>}
    </div>
  );
}
