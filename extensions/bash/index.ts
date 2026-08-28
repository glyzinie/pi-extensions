import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type BashSpawnContext,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 1;

const EVENTS = {
  discover: "pi-bash:discover",
  registerTransform: "pi-bash:register-transform",
  registerBackend: "pi-bash:register-backend",
} as const;

interface BashTransform {
  id: string;
  priority?: number;
  transform(context: BashSpawnContext): BashSpawnContext | void;
}

interface BashBackend {
  id: string;
  priority?: number;
  operations: BashOperations;
  supports?(context: BashSpawnContext): boolean;
}

interface TransformRegistration {
  protocolVersion: number;
  transform: BashTransform;
}

interface BackendRegistration {
  protocolVersion: number;
  backend: BashBackend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransformRegistration(value: unknown): value is TransformRegistration {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  const transform = value.transform;
  return (
    isRecord(transform) &&
    typeof transform.id === "string" &&
    typeof transform.transform === "function"
  );
}

function isBackendRegistration(value: unknown): value is BackendRegistration {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) return false;
  const backend = value.backend;
  return (
    isRecord(backend) &&
    typeof backend.id === "string" &&
    isRecord(backend.operations) &&
    typeof backend.operations.exec === "function"
  );
}

function byPriority<T extends { id: string; priority?: number }>(
  values: Iterable<T>,
): T[] {
  return [...values].sort((a, b) => {
    const priority = (b.priority ?? 0) - (a.priority ?? 0);
    return priority !== 0 ? priority : a.id.localeCompare(b.id);
  });
}

export default function bashExtension(pi: ExtensionAPI): void {
  const transforms = new Map<string, BashTransform>();
  const backends = new Map<string, BashBackend>();
  const localOperations = createLocalBashOperations();

  pi.events.on(EVENTS.registerTransform, (data) => {
    if (!isTransformRegistration(data)) return;
    transforms.set(data.transform.id, data.transform);
  });

  pi.events.on(EVENTS.registerBackend, (data) => {
    if (!isBackendRegistration(data)) return;
    backends.set(data.backend.id, data.backend);
  });

  const discover = () => {
    pi.events.emit(EVENTS.discover, { protocolVersion: PROTOCOL_VERSION });
  };

  const createOperations = (applyTransforms: boolean): BashOperations => ({
    async exec(command, cwd, options) {
      let current: BashSpawnContext = {
        command,
        cwd,
        env: { ...(options.env ?? process.env) },
      };

      if (applyTransforms) {
        for (const transform of byPriority(transforms.values())) {
          try {
            const next = transform.transform({
              command: current.command,
              cwd: current.cwd,
              env: { ...current.env },
            });
            if (next) current = next;
          } catch {
            // Optimizers are best-effort. Never prevent execution because an
            // optional transform failed.
          }
        }
      }

      let selected: BashBackend | undefined;
      for (const backend of byPriority(backends.values())) {
        try {
          if (!backend.supports || backend.supports(current)) {
            selected = backend;
            break;
          }
        } catch {
          // Ignore a backend that cannot determine support.
        }
      }

      // A selected backend is a security/execution boundary. If it fails,
      // propagate the failure instead of silently bypassing it with local bash.
      const operations = selected?.operations ?? localOperations;
      return operations.exec(current.command, current.cwd, {
        ...options,
        env: current.env,
      });
    },
  });

  // Use Pi's own bash implementation for schema, streaming, timeout handling,
  // rendering, and output truncation. Only the prompt + execution pipeline are
  // customized here.
  const base = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...base,
    label: "bash",
    promptSnippet:
      "Execute shell commands; prefer dedicated read, grep, find, and ls tools for file inspection.",
    promptGuidelines: [],
    async execute(id, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      return createBashToolDefinition(cwd, {
        operations: createOperations(true),
        exposeSessionEnvironment: true,
      }).execute(id, params, signal, onUpdate, ctx);
    },
  });

  // Keep !cmd on the same execution backend. For !!cmd, skip RTK-like
  // transforms because the output is intentionally excluded from model context,
  // but still keep the sandbox/backend boundary.
  pi.on("user_bash", (event) => ({
    operations: createOperations(!event.excludeFromContext),
  }));

  pi.registerCommand("bash-stack", {
    description: "Show registered bash transforms and execution backends",
    handler: async (_args, ctx) => {
      const transformList =
        byPriority(transforms.values()).map((item) => item.id).join(", ") || "none";
      const backendList =
        byPriority(backends.values()).map((item) => item.id).join(", ") || "local";
      ctx.ui.notify(
        `bash stack\ntransforms: ${transformList}\nbackends: ${backendList}`,
        "info",
      );
    },
  });

  queueMicrotask(discover);
  pi.on("session_start", () => discover());
}
