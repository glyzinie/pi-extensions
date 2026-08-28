import { spawnSync } from "node:child_process";

import type {
  BashSpawnContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const REWRITE_TIMEOUT_MS = 2_000;

const EVENTS = {
  discover: "pi-bash:discover",
  registerTransform: "pi-bash:register-transform",
} as const;

let enabled = true;
let warnedUnavailable = false;

function rewrite(command: string): string | undefined {
  try {
    const result = spawnSync("rtk", ["rewrite", command], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.error) return undefined;

    const output = (result.stdout ?? "").trimEnd();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function version(): string | undefined {
  try {
    const result = spawnSync("rtk", ["--version"], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error) return undefined;
    return (result.stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export default function piRtk(pi: ExtensionAPI): void {
  const transform = {
    id: "rtk",
    priority: 100,

    transform(context: BashSpawnContext): BashSpawnContext {
      if (!enabled || context.env.RTK_DISABLED === "1") return context;

      const rewritten = rewrite(context.command);
      if (!rewritten) return context;

      return {
        command: rewritten,
        cwd: context.cwd,
        env: context.env,
      };
    },
  };

  const register = () => {
    pi.events.emit(EVENTS.registerTransform, {
      protocolVersion: PROTOCOL_VERSION,
      transform,
    });
  };

  pi.events.on(EVENTS.discover, (data) => {
    if (
      typeof data === "object" &&
      data !== null &&
      (data as any).protocolVersion === PROTOCOL_VERSION
    ) {
      register();
    }
  });

  pi.on("session_start", (_event, ctx) => {
    register();

    if (!version() && !warnedUnavailable && ctx.hasUI) {
      warnedUnavailable = true;
      ctx.ui.notify(
        "pi-rtk: rtk binary not found; commands will run unchanged",
        "warning",
      );
    }
  });

  pi.registerCommand("rtk", {
    description: "Control RTK bash rewriting: enable | disable | status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "enable" || action === "on") {
        enabled = true;
        ctx.ui.notify("pi-rtk enabled", "info");
        return;
      }

      if (action === "disable" || action === "off") {
        enabled = false;
        ctx.ui.notify("pi-rtk disabled", "info");
        return;
      }

      if (action === "" || action === "status") {
        ctx.ui.notify(
          `pi-rtk: ${enabled ? "enabled" : "disabled"}\nrtk: ${version() ?? "not found"}`,
          "info",
        );
        return;
      }

      ctx.ui.notify("Usage: /rtk [enable|disable|status]", "warning");
    },
  });

  queueMicrotask(register);
}
