import { defaultRegistry, SimulationHost } from "@distro-lab/core";
import type { FromWorker, ToWorker } from "./protocol.ts";

// The app compiles against DOM types; only these worker globals are needed here.
const scope = globalThis as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const registry = defaultRegistry();
let host: SimulationHost | undefined;
let lastTick = performance.now();

const post = (message: FromWorker) => scope.postMessage(message);
const postFrame = (cause: ToWorker["type"] | "tick") => {
  if (host !== undefined) post({ type: "frame", frame: host.frame(), cause });
};

function handle(message: ToWorker): void {
  if (message.type === "load") {
    host = new SimulationHost(registry, message.scenario);
    postFrame("load");
    return;
  }
  if (host === undefined) throw new Error("no scenario loaded");
  switch (message.type) {
    case "play":
      host.playing = true;
      lastTick = performance.now();
      break;
    case "pause":
      host.playing = false;
      break;
    case "speed":
      host.speed = message.speed;
      break;
    case "step":
      host.step();
      break;
    case "stepNotable":
      host.stepToNotable();
      break;
    case "stepBack":
      host.stepBack();
      break;
    case "stepBackNotable":
      host.stepBackToNotable();
      break;
    case "seek":
      host.seek(message.timeMs);
      break;
    case "seekRecord":
      host.seekRecord(message.id);
      break;
    case "seekFirstViolation":
      host.seekToFirstViolation();
      break;
    case "act":
      host.act(message.action);
      break;
    case "fork":
      host.fork(message.name);
      break;
    case "switchBranch":
      host.switchBranch(message.id);
      break;
    case "deleteBranch":
      host.deleteBranch(message.id);
      break;
    case "addBranch":
      host.addBranch(message.name, message.scenario);
      break;
    case "renameBranch":
      host.renameBranch(message.id, message.name);
      break;
    case "editActions":
      host.editActions(message.actions);
      break;
    case "compare":
      post({
        type: "comparison",
        requestId: message.requestId,
        comparison: host.compare(message.other),
      });
      return;
    case "export":
      post({ type: "scenario", requestId: message.requestId, scenario: host.scenario() });
      return;
  }
  postFrame(message.type);
}

scope.onmessage = (event) => {
  try {
    handle(event.data);
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};

// Playback loop: advance virtual time by real elapsed time × speed, one frame per tick.
const FRAME_MS = 1000 / 60;
function loop(): void {
  const now = performance.now();
  const elapsed = Math.min(now - lastTick, 250); // don't jump after the tab was hidden
  lastTick = now;
  if (host?.playing === true) {
    try {
      host.tick(elapsed);
      postFrame("tick");
    } catch (e) {
      host.playing = false;
      post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  setTimeout(loop, FRAME_MS);
}
loop();
