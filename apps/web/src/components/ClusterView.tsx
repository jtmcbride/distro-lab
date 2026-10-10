import { useRef, useState } from "react";
import type { LinkNetworkView, ProcessState } from "@distro-lab/core";
import {
  clientCaption,
  electionTimer,
  MESSAGE_LEGEND,
  messageStyle,
  serverBadge,
} from "../protocolUi.ts";
import { sim } from "../sim/client.ts";
import { inFlight } from "../state/inflight.ts";
import { useSim } from "../state/store.ts";

const W = 640;
const H = 420;
const NODE_R = 26;

type Point = { x: number; y: number };

/** Servers on a circle, clients in a row underneath. */
function defaultLayout(servers: string[], clients: string[]): Map<string, Point> {
  const pos = new Map<string, Point>();
  const cx = W / 2;
  const cy = clients.length > 0 ? 175 : H / 2;
  const r = Math.min(140, 40 + servers.length * 22);
  servers.forEach((id, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / servers.length;
    pos.set(id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  clients.forEach((id, i) => {
    const span = 90 * (clients.length - 1);
    pos.set(id, { x: cx - span / 2 + 90 * i, y: H - 34 });
  });
  return pos;
}

const lerp = (a: Point, b: Point, f: number): Point => ({
  x: a.x + (b.x - a.x) * f,
  y: a.y + (b.y - a.y) * f,
});

/** Shortens a segment so it starts and ends at the node outlines. */
function trim(a: Point, b: Point, by: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const f = by / d;
  return [lerp(a, b, f), lerp(a, b, 1 - f)];
}

export function ClusterView() {
  const { processes, network, now, speed, config, selectedProcess } = useSim();
  useSim((s) => s.traceVersion);
  const [dragged, setDragged] = useState<Record<string, Point>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; moved: boolean } | null>(null);

  const servers = processes.filter((p) => p.role === "server");
  const clients = processes.filter((p) => p.role === "client");
  const layout = defaultLayout(
    servers.map((p) => p.id),
    clients.map((p) => p.id),
  );
  const pos = (id: string): Point => dragged[id] ?? layout.get(id) ?? { x: 0, y: 0 };

  inFlight.update();
  const messages = inFlight.inFlight(now);
  // Show drops for ~0.4s of real time whatever the speed.
  const drops = inFlight.recentDrops(now, 400 * speed);

  const links = (network as LinkNetworkView | null)?.links ?? [];
  const connected = new Map(links.map((l) => [`${l.from}>${l.to}`, l]));
  const timer = electionTimer(config);

  const toSvg = (e: React.PointerEvent): Point => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return {
      x: Math.max(NODE_R, Math.min(W - NODE_R, p.x)),
      y: Math.max(NODE_R, Math.min(H - NODE_R, p.y)),
    };
  };

  const nodeHandlers = (p: ProcessState) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      drag.current = { id: p.id, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (drag.current?.id !== p.id) return;
      drag.current.moved = true;
      setDragged((d) => ({ ...d, [p.id]: toSvg(e) }));
    },
    onPointerUp: () => {
      if (drag.current?.id === p.id && !drag.current.moved) {
        useSim.setState({ selectedProcess: selectedProcess === p.id ? null : p.id });
      }
      drag.current = null;
    },
  });

  // One line per pair of servers, and faint client links.
  const pairs: {
    a: string;
    b: string;
    ab: boolean;
    ba: boolean;
    slow: boolean;
    client: boolean;
  }[] = [];
  const ids = processes.map((p) => p.id);
  ids.forEach((a, i) =>
    ids.slice(i + 1).forEach((b) => {
      const ab = connected.get(`${a}>${b}`);
      const ba = connected.get(`${b}>${a}`);
      if (ab === undefined || ba === undefined) return;
      const client = clients.some((c) => c.id === a || c.id === b);
      if (client && clients.some((c) => c.id === a) && clients.some((c) => c.id === b)) return;
      const slow = [ab, ba].some((l) => l.latencyMs >= 50 || l.loss > 0 || l.duplicate > 0);
      pairs.push({ a, b, ab: ab.connected, ba: ba.connected, slow, client });
    }),
  );

  const selected = processes.find((p) => p.id === selectedProcess);

  return (
    <div className="cluster-view">
      <div className="cluster-toolbar" role="toolbar" aria-label="Node actions">
        {selected === undefined ? (
          <span className="muted">Click a node to select it; drag to move it.</span>
        ) : (
          <>
            <strong>{selected.id}</strong>
            <button
              type="button"
              onClick={() =>
                sim.act({ type: selected.up ? "crash" : "recover", node: selected.id })
              }
            >
              {selected.up ? "Crash" : "Recover"}
            </button>
            <button
              type="button"
              onClick={() =>
                sim.act({ type: "network", change: { type: "isolate", node: selected.id } })
              }
            >
              Isolate
            </button>
            {selected.role === "server" && (
              <button
                type="button"
                disabled={!selected.up}
                onClick={() => sim.act({ type: "timeout", node: selected.id, key: timer.key })}
                title="Fire this node's election timer now"
              >
                Force election
              </button>
            )}
          </>
        )}
        <button
          type="button"
          className="push-right"
          onClick={() => sim.act({ type: "network", change: { type: "heal" } })}
        >
          Heal partitions
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="cluster-svg"
        role="img"
        aria-label="Cluster topology with messages in flight"
      >
        {pairs.map(({ a, b, ab, ba, slow, client }) => {
          const [p, q] = trim(pos(a), pos(b), NODE_R + 2);
          const state = ab && ba ? "up" : ab || ba ? "half" : "down";
          return (
            <line
              key={`${a}-${b}`}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              className={`link link-${state}${slow ? " link-slow" : ""}${client ? " link-client" : ""}`}
            >
              <title>
                {a}→{b} {ab ? "up" : "down"}, {b}→{a} {ba ? "up" : "down"}
                {slow ? " (degraded)" : ""}
              </title>
            </line>
          );
        })}

        {processes.map((p) => {
          const c = pos(p.id);
          if (p.role === "client") {
            return (
              <g
                key={p.id}
                className={`node client${p.up ? "" : " down"}${p.id === selectedProcess ? " selected" : ""}`}
                {...nodeHandlers(p)}
              >
                <rect x={c.x - 24} y={c.y - 16} width={48} height={32} rx={8} />
                <text x={c.x} y={c.y + 1} className="node-id">
                  {p.id}
                </text>
                <text x={c.x} y={c.y + 28} className="node-caption">
                  {p.up ? clientCaption(p.view) : "down"}
                </text>
              </g>
            );
          }
          const badge = serverBadge(p.view);
          const election = p.timers.find((t) => t.key === timer.key);
          const remaining =
            election === undefined
              ? 0
              : Math.max(0, Math.min(1, (election.at - now) / timer.maxMs));
          const ring = 2 * Math.PI * (NODE_R + 5);
          return (
            <g
              key={p.id}
              // A crashed node keeps its last state; showing its old role would mislead.
              className={`node server ${p.up ? `role-${badge.role}` : "down"}${p.id === selectedProcess ? " selected" : ""}`}
              {...nodeHandlers(p)}
            >
              {p.up && election !== undefined && (
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={NODE_R + 5}
                  className="timer-ring"
                  strokeDasharray={`${ring * remaining} ${ring}`}
                  transform={`rotate(-90 ${c.x} ${c.y})`}
                >
                  <title>Election timeout in {(election.at - now).toFixed(0)} ms</title>
                </circle>
              )}
              <circle cx={c.x} cy={c.y} r={NODE_R} />
              <text x={c.x} y={c.y - 2} className="node-id">
                {p.id}
              </text>
              <text x={c.x} y={c.y + 13} className="node-term">
                {p.up ? badge.caption : "down"}
              </text>
              <title>
                {p.id}: {p.up ? badge.role : "crashed"} {badge.caption}
              </title>
            </g>
          );
        })}

        {messages.map((m) => {
          const [a, b] = trim(pos(m.from), pos(m.to), NODE_R);
          const f = m.arrival === m.t ? 1 : (now - m.t) / (m.arrival - m.t);
          const at = lerp(a, b, Math.max(0, Math.min(1, f)));
          const style = messageStyle(m.message);
          return (
            <circle
              key={m.key}
              cx={at.x}
              cy={at.y}
              r={style.minor ? 3 : 5}
              className={`msg${style.minor ? " minor" : ""}`}
              style={{ fill: style.color }}
              onClick={() => useSim.setState({ selectedRecord: m.send })}
            >
              <title>
                {style.label} {m.from}→{m.to}
              </title>
            </circle>
          );
        })}

        {drops.map((d) => {
          const [a, b] = trim(pos(d.from), pos(d.to), NODE_R);
          const at = lerp(a, b, d.atSend ? 0.15 : 0.85);
          return (
            <g key={d.key} className="drop">
              <line x1={at.x - 5} y1={at.y - 5} x2={at.x + 5} y2={at.y + 5} />
              <line x1={at.x - 5} y1={at.y + 5} x2={at.x + 5} y2={at.y - 5} />
              <title>
                Dropped {d.from}→{d.to} ({d.reason})
              </title>
            </g>
          );
        })}
      </svg>

      <div className="legend" aria-label="Legend">
        <span className="swatch role-leader">Leader</span>
        <span className="swatch role-candidate">Candidate</span>
        <span className="swatch role-follower">Follower</span>
        {MESSAGE_LEGEND.map((m) => (
          <span key={m.label} className="dot" style={{ ["--c" as string]: m.color }}>
            {m.label}
          </span>
        ))}
        <span className="muted">Ring: time left before an election timeout</span>
      </div>
    </div>
  );
}
