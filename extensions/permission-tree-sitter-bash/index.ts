import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PERMISSION_EVENTS,
  PERMISSION_PROTOCOL_VERSION,
  type PermissionAnalyzer,
  type RegisterAnalyzerEvent,
} from "../permission/protocol.ts";
import { analyzeBashSource, invalidBashAnalysis } from "./bash-cst.ts";
import {
  BASH_ANALYSIS_KIND,
  TREE_SITTER_BASH_PLUGIN_ID,
} from "./types.ts";

const analyzer: PermissionAnalyzer = {
  id: TREE_SITTER_BASH_PLUGIN_ID,
  priority: 100,
  supports: (request) => request.toolName === "bash",
  async analyze(request) {
    const command = request.input.command;
    const data = typeof command === "string"
      ? await analyzeBashSource(command)
      : invalidBashAnalysis("", "bash input.command is not a string");
    return {
      kind: BASH_ANALYSIS_KIND,
      data,
      warnings: [...data.warnings],
    };
  },
};

export default function permissionTreeSitterBash(pi: ExtensionAPI): void {
  const register = () => {
    const event: RegisterAnalyzerEvent = {
      protocolVersion: PERMISSION_PROTOCOL_VERSION,
      analyzer,
    };
    pi.events.emit(PERMISSION_EVENTS.registerAnalyzer, event);
  };

  pi.events.on(PERMISSION_EVENTS.discover, (data) => {
    if (
      typeof data === "object" &&
      data !== null &&
      "protocolVersion" in data &&
      data.protocolVersion === PERMISSION_PROTOCOL_VERSION
    ) {
      register();
    }
  });

  register();
}

export { analyzeBashSource } from "./bash-cst.ts";
export type { BashTreeSitterAnalysis } from "./types.ts";
