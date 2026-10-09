import type { Protocol } from "../src/index.ts";

/** Small protocol exercising every engine feature; used only by engine tests. */
export interface ToyPersistent {
  counter: number;
}
export interface ToyVolatile {
  received: number;
  lastFrom: string | null;
}
export type ToyMessage =
  { kind: "ping"; n: number; payload: number[] } | { kind: "pong"; n: number };
export type ToyCommand = { set: number } | { timer: "arm-and-cancel" | "arm-late" };

export const TICK_MS = 10;

export const toyProtocol: Protocol<ToyPersistent, ToyVolatile, ToyMessage, ToyCommand> = {
  name: "toy",
  init(ctx) {
    ctx.setTimer("tick", TICK_MS + ctx.rng.int(0, 5));
    return { persistent: { counter: 0 }, volatile: { received: 0, lastFrom: null } };
  },
  recover(ctx, persistent) {
    ctx.annotate("recovered", { counter: persistent.counter });
    ctx.setTimer("tick", TICK_MS + ctx.rng.int(0, 5));
    return { persistent, volatile: { received: 0, lastFrom: null } };
  },
  onTimer(ctx, state, key) {
    if (key === "late") ctx.annotate("late-fired");
    if (key !== "tick") return;
    state.persistent.counter++;
    for (const p of ctx.peers) {
      ctx.send(p, { kind: "ping", n: state.persistent.counter, payload: [1, 2, 3] });
    }
    ctx.setTimer("tick", TICK_MS + ctx.rng.int(0, 5));
  },
  onMessage(ctx, state, from, message) {
    state.volatile.received++;
    state.volatile.lastFrom = from;
    if (message.kind === "ping") {
      // Mutating a received message must never affect other copies.
      message.payload.push(99);
      ctx.send(from, { kind: "pong", n: message.n });
    }
  },
  onClientCommand(ctx, state, command) {
    if ("set" in command) {
      state.persistent.counter = command.set;
      ctx.annotate("set", command.set);
    } else if (command.timer === "arm-late") {
      ctx.setTimer("late", 100);
    } else {
      ctx.setTimer("extra", 1);
      ctx.cancelTimer("extra");
    }
  },
  view(state) {
    return {
      counter: state.persistent.counter,
      received: state.volatile.received,
      lastFrom: state.volatile.lastFrom,
    };
  },
};
