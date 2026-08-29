/**
 * Lightweight macOS notifications for Pi.
 *
 * Uses terminal OSC notifications when available and falls back to osascript.
 * There are no dependencies or background resources; a sound process is
 * started only when a notification is sent through OSC.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type OscProtocol = "99" | "9" | "777";

const MIN_DURATION_MS = 5_000;
const SETTLED_SOUND = "Glass";
const INPUT_SOUND = "Ping";
const NOTIFICATION_SCRIPT = `on run argv
display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)
end run`;

function sanitize(text: string, maxLength = 240): string {
  return text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function detectOscProtocol(): OscProtocol | undefined {
  const terminal = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`
    .toLowerCase();

  if (process.env.KITTY_WINDOW_ID || terminal.includes("kitty")) return "99";
  if (terminal.includes("iterm")) return "9";
  if (/ghostty|wezterm|rxvt/.test(terminal)) return "777";
  return undefined;
}

export default function notifyExtension(pi: ExtensionAPI) {
  if (process.platform !== "darwin") return;

  const oscProtocol = detectOscProtocol();
  let startedAt: number | undefined;

  function runQuietly(command: string, args: string[]): void {
    try {
      void pi.exec(command, args, { timeout: 5_000 }).catch(() => {});
    } catch {
      // A notification must not affect Pi if the session was replaced.
    }
  }

  function notify(title: string, body: string, sound: string, mode: string): void {
    const safeTitle = sanitize(title);
    const safeBody = sanitize(body);

    try {
      if (mode === "tui" && process.stdout.isTTY === true && oscProtocol) {
        let sequence: string;
        if (oscProtocol === "99") {
          sequence =
            `\x1b]99;i=pi-notify:d=0;${safeTitle}\x1b\\` +
            `\x1b]99;i=pi-notify:p=body;${safeBody}\x1b\\`;
        } else if (oscProtocol === "9") {
          sequence = `\x1b]9;${safeTitle} · ${safeBody}\x07`;
        } else {
          sequence = `\x1b]777;notify;${safeTitle.replaceAll(";", ",")};${safeBody.replaceAll(";", ",")}\x07`;
        }

        process.stdout.write(sequence);
        runQuietly("/usr/bin/afplay", [
          `/System/Library/Sounds/${sound}.aiff`,
        ]);
        return;
      }

      runQuietly("/usr/bin/osascript", [
        "-e",
        NOTIFICATION_SCRIPT,
        safeTitle,
        safeBody,
        sound,
      ]);
    } catch {
      // Notifications are best-effort.
    }
  }

  pi.on("agent_start", () => {
    // Retries and compaction can start the agent again within the same run.
    startedAt ??= performance.now();
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    notify(
      "Pi · Input required",
      event.title ?? `${event.kind} input required`,
      INPUT_SOUND,
      ctx.mode,
    );
  });

  pi.on("agent_settled", (_event, ctx) => {
    const start = startedAt;
    if (start === undefined) return;

    if (!ctx.isIdle()) {
      startedAt = performance.now();
      return;
    }

    startedAt = undefined;
    const durationMs = performance.now() - start;
    if (durationMs < MIN_DURATION_MS) return;

    notify(
      "Pi · Ready",
      `Ready for input · ${formatDuration(durationMs)}`,
      SETTLED_SOUND,
      ctx.mode,
    );
  });
}
