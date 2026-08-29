import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING = "思考中...";
const EXECUTING = "実行中...";

export default function jaUi(pi: ExtensionAPI) {
  let runningTools = 0;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHiddenThinkingLabel(THINKING);
    ctx.ui.setWorkingMessage(THINKING);
  });

  pi.on("tool_execution_start", (_event, ctx) => {
    if (runningTools++ === 0) ctx.ui.setWorkingMessage(EXECUTING);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    if (--runningTools === 0) ctx.ui.setWorkingMessage(THINKING);
  });
}
