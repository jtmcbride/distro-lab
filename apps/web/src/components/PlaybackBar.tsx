import { useEffect, useState } from "react";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";

const SPEEDS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10];

export const formatMs = (ms: number) =>
  `${ms.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;

/** Play/pause, stepping, speed, and a scrubber that seeks by deterministic replay. */
export function PlaybackBar() {
  const { now, durationMs, playing, speed, events, idle } = useSim();
  // While dragging, show the scrub position locally; seek once on release.
  const [scrub, setScrub] = useState<number | null>(null);
  const end = Math.max(durationMs, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, button") != null) return;
      if (e.key === " ") {
        e.preventDefault();
        if (useSim.getState().playing) sim.pause();
        else sim.play();
      } else if (e.key === "ArrowRight") {
        if (e.shiftKey) sim.stepNotable();
        else sim.step();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="playback" role="toolbar" aria-label="Playback">
      <button type="button" onClick={() => sim.seek(0)} title="Restart">
        ⏮
      </button>
      <button
        type="button"
        className="primary"
        onClick={() => (playing ? sim.pause() : sim.play())}
        title="Play / pause (space)"
      >
        {playing ? "⏸ Pause" : "▶ Play"}
      </button>
      <button type="button" onClick={() => sim.step()} title="One event (→)" disabled={playing}>
        Step
      </button>
      <button
        type="button"
        onClick={() => sim.stepNotable()}
        title="Run to the next election, leader change, completed request or violation (shift+→)"
        disabled={playing}
      >
        Next notable
      </button>
      <label className="speed">
        Speed
        <select value={speed} onChange={(e) => sim.setSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
      <input
        className="scrubber"
        type="range"
        aria-label="Virtual time"
        min={0}
        max={end}
        step={1}
        value={scrub ?? now}
        onChange={(e) => setScrub(Number(e.target.value))}
        onPointerUp={() => {
          if (scrub !== null) sim.seek(scrub);
          setScrub(null);
        }}
        onKeyUp={() => {
          if (scrub !== null) sim.seek(scrub);
          setScrub(null);
        }}
      />
      <span className="clock" aria-live="off">
        {formatMs(scrub ?? now)}
        <span className="muted">
          {" "}
          · {events.toLocaleString()} events{idle ? " · idle" : ""}
        </span>
      </span>
    </div>
  );
}
