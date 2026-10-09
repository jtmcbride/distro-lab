import { useEffect, useRef, useState } from "react";
import { messageStyle } from "../protocolUi.ts";
import { useSim } from "../state/store.ts";
import { trace } from "../state/trace.ts";
import { firstAtOrAfter, outcomesIn } from "../state/traceIndex.ts";

const ROW_H = 30;
const LEFT = 44;
const TOP = 18;
/** Look this far back for sends whose arrows reach into the window. */
const LOOKBACK_MS = 2000;

interface Segment {
  send: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Resolves a CSS colour (including var(--x)) for canvas drawing. */
function resolveColor(el: Element, color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  return m === null ? color : getComputedStyle(el).getPropertyValue(m[1]!).trim() || "#888";
}

/**
 * Space-time diagram: one row per process, time to the right, an arrow per message copy from
 * its send to its arrival (or drop). Follows the playhead unless the view was panned.
 */
export function SpaceTime() {
  const { now, processes, selectedRecord, traceVersion } = useSim();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const segments = useRef<Segment[]>([]);
  const [width, setWidth] = useState(800);
  const [msPerPx, setMsPerPx] = useState(1);
  const [pinnedEnd, setPinnedEnd] = useState<number | null>(null); // null = follow playhead
  const [hideHeartbeats, setHideHeartbeats] = useState(false);
  const pan = useRef<{ x: number; end: number; moved: boolean } | null>(null);

  const ids = processes.map((p) => p.id);
  const height = TOP + ids.length * ROW_H + 8;
  const plotW = Math.max(100, width - LEFT - 8);
  const end = pinnedEnd ?? Math.max(now + plotW * msPerPx * 0.05, plotW * msPerPx * 0.95);
  const start = end - plotW * msPerPx;

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (el == null) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const color = (c: string) => resolveColor(canvas, c);
    const fg = color("var(--fg)");
    const muted = color("var(--muted)");
    const border = color("var(--border)");
    const bad = color("var(--bad)");
    const accent = color("var(--accent)");
    const x = (t: number) => LEFT + (t - start) / msPerPx;
    const row = new Map(ids.map((id, i) => [id, TOP + i * ROW_H + ROW_H / 2]));

    // Time axis ticks.
    const step = niceStep(msPerPx * 120);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    for (let t = Math.max(0, Math.ceil(start / step) * step); t <= end; t += step) {
      const px = x(t);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(px, TOP - 4);
      ctx.lineTo(px, height - 4);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(`${t.toLocaleString()} ms`, px + 3, 10);
    }

    // Lifelines, with down periods shaded.
    const from = firstAtOrAfter(start - LOOKBACK_MS);
    const to = firstAtOrAfter(end + 0.001);
    // Walk backwards from the window end to find which processes were down at its start.
    const downAtStart = new Set<string>();
    {
      const state = new Map<string, boolean>();
      for (let i = Math.min(to, trace.length) - 1; i >= 0 && state.size < ids.length; i--) {
        const r = trace[i]!;
        if ((r.type === "crash" || r.type === "recover") && r.t < start && !state.has(r.node)) {
          state.set(r.node, r.type === "crash");
        }
      }
      for (const [id, down] of state) if (down) downAtStart.add(id);
    }
    const downSpans: { id: string; a: number; b: number }[] = [];
    const open = new Map<string, number>([...downAtStart].map((id) => [id, start]));
    for (let i = firstAtOrAfter(start); i < to; i++) {
      const r = trace[i]!;
      if (r.type === "crash") open.set(r.node, r.t);
      if (r.type === "recover" && open.has(r.node)) {
        downSpans.push({ id: r.node, a: open.get(r.node)!, b: r.t });
        open.delete(r.node);
      }
    }
    for (const [id, a] of open) downSpans.push({ id, a, b: Math.min(end, now) });

    ctx.font = "bold 12px system-ui, sans-serif";
    for (const id of ids) {
      const y = row.get(id)!;
      ctx.fillStyle = fg;
      ctx.fillText(id, 6, y + 4);
      ctx.strokeStyle = border;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(LEFT, y);
      ctx.lineTo(Math.min(x(now), width), y);
      ctx.stroke();
    }
    for (const s of downSpans) {
      const y = row.get(s.id);
      if (y === undefined) continue;
      ctx.fillStyle = bad;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(x(s.a), y - ROW_H / 2 + 3, x(s.b) - x(s.a), ROW_H - 6);
      ctx.globalAlpha = 1;
    }

    // Messages.
    const outcomes = outcomesIn(from, Math.min(trace.length, firstAtOrAfter(end + LOOKBACK_MS)));
    const segs: Segment[] = [];
    for (let i = from; i < to; i++) {
      const r = trace[i]!;
      if (r.type !== "send") continue;
      const style = messageStyle(r.message);
      if (hideHeartbeats && style.minor) continue;
      const y1 = row.get(r.from);
      const y2 = row.get(r.to);
      if (y1 === undefined || y2 === undefined) continue;
      const selected = r.id === selectedRecord;
      ctx.strokeStyle = selected ? accent : color(style.color);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = selected ? 2.5 : style.minor ? 0.8 : 1.4;
      ctx.globalAlpha = selected ? 1 : style.minor ? 0.45 : 0.9;
      const results = outcomes.get(r.id) ?? [];
      if (r.arrivals.length === 0) {
        // Dropped when sent: a short stub with a cross.
        const x1 = x(r.t);
        const yEnd = y1 + (y2 - y1) * 0.25;
        line(ctx, x1, y1, x1 + 8, yEnd);
        cross(ctx, x1 + 8, yEnd, bad);
        segs.push({ send: r.id, x1, y1, x2: x1 + 8, y2: yEnd });
      }
      r.arrivals.forEach((arrival, k) => {
        const outcome = results[k];
        const endT = Math.min(arrival, now);
        const x1 = x(r.t);
        const f = arrival === r.t ? 1 : (endT - r.t) / (arrival - r.t);
        const x2 = x(endT);
        const yEnd = y1 + (y2 - y1) * f;
        line(ctx, x1, y1, x2, yEnd);
        if (outcome?.kind === "dropped") cross(ctx, x2, yEnd, bad);
        else if (outcome?.kind === "delivered") arrow(ctx, x1, y1, x2, yEnd);
        segs.push({ send: r.id, x1, y1, x2, y2: yEnd });
      });
      ctx.globalAlpha = 1;
    }
    segments.current = segs;

    // Protocol milestones.
    for (let i = firstAtOrAfter(start); i < to; i++) {
      const r = trace[i]!;
      if (r.type !== "annotate") continue;
      const y = row.get(r.node);
      if (y === undefined) continue;
      if (r.label === "becameLeader") marker(ctx, x(r.t), y, color("var(--leader)"), "★");
      else if (r.label === "electionStarted")
        marker(ctx, x(r.t), y, color("var(--candidate)"), "◆");
      else if (r.label === "complete") marker(ctx, x(r.t), y, color("var(--good)"), "✓");
    }

    // Playhead.
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x(now), TOP - 6);
    ctx.lineTo(x(now), height - 2);
    ctx.stroke();
  }, [
    traceVersion,
    now,
    width,
    height,
    msPerPx,
    start,
    end,
    selectedRecord,
    hideHeartbeats,
    processes,
    ids,
  ]);

  const pick = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: { send: number; d: number } | null = null;
    for (const s of segments.current) {
      const d = distanceToSegment(px, py, s);
      if (d < 6 && (best === null || d < best.d)) best = { send: s.send, d };
    }
    useSim.setState({ selectedRecord: best?.send ?? null });
  };

  return (
    <div className="spacetime">
      <div className="spacetime-controls">
        <button type="button" onClick={() => setMsPerPx((m) => Math.max(0.05, m / 1.5))}>
          Zoom in
        </button>
        <button type="button" onClick={() => setMsPerPx((m) => Math.min(200, m * 1.5))}>
          Zoom out
        </button>
        <button type="button" disabled={pinnedEnd === null} onClick={() => setPinnedEnd(null)}>
          Follow playhead
        </button>
        <label>
          <input
            type="checkbox"
            checked={hideHeartbeats}
            onChange={(e) => setHideHeartbeats(e.target.checked)}
          />
          Hide heartbeats
        </label>
        <span className="muted">
          {(plotW * msPerPx).toLocaleString(undefined, { maximumFractionDigits: 0 })} ms shown ·
          drag to pan, wheel to zoom, click an arrow
        </span>
      </div>
      <div className="spacetime-canvas">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Space-time diagram of messages between processes"
          onWheel={(e) => {
            const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
            setMsPerPx((m) => Math.max(0.05, Math.min(200, m * factor)));
          }}
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            pan.current = { x: e.clientX, end, moved: false };
          }}
          onPointerMove={(e) => {
            if (pan.current === null) return;
            const dx = e.clientX - pan.current.x;
            if (Math.abs(dx) > 3) pan.current.moved = true;
            if (pan.current.moved) setPinnedEnd(pan.current.end - dx * msPerPx);
          }}
          onPointerUp={(e) => {
            if (pan.current !== null && !pan.current.moved) pick(e);
            pan.current = null;
          }}
        />
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const s = 5;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - s * Math.cos(a - 0.4), y2 - s * Math.sin(a - 0.4));
  ctx.lineTo(x2 - s * Math.cos(a + 0.4), y2 - s * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  const prev = ctx.strokeStyle;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  line(ctx, x - 4, y - 4, x + 4, y + 4);
  line(ctx, x - 4, y + 4, x + 4, y - 4);
  ctx.strokeStyle = prev;
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, glyph: string) {
  ctx.fillStyle = color;
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(glyph, x, y - 6);
  ctx.textAlign = "start";
}

function distanceToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = dx * dx + dy * dy;
  const f = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len));
  return Math.hypot(px - (s.x1 + f * dx), py - (s.y1 + f * dy));
}
