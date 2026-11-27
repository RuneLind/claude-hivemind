/**
 * Adapts OpenCode 2.x's plugin session domain (`ctx.session`) to the
 * SessionClient slice SessionInbox calls, so one inbox serves both versions.
 *
 * 2.x has a native session inbox: `session.prompt` admits a user message into
 * a session, starting a turn when it is idle. It is sent with delivery
 * "queue", so a message that arrives mid-turn waits for the turn to end, as
 * 1.19's prompt_async does, instead of steering the running turn. It carries
 * no agent or model: a 2.x session keeps its own selection.
 */

import type { Plugin } from "@opencode/plugin";
import type { SessionClient } from "./session-inbox.ts";

export type V2Session = Pick<Plugin.Context["session"], "prompt" | "get">;

const NO_TUI = { error: "OpenCode 2.x plugins have no TUI calls" };

export function v2SessionClient(session: V2Session): SessionClient {
  return {
    session: {
      async promptAsync({ path, body }) {
        try {
          await session.prompt({
            sessionID: path.id,
            text: body.parts.map((p) => p.text).join("\n"),
            delivery: "queue",
          });
          return {};
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
      async get({ path }) {
        const s = await session.get({ sessionID: path.id });
        return { data: { id: s.id, parentID: s.parentID } };
      },
    },
    tui: {
      appendPrompt: async () => NO_TUI,
      submitPrompt: async () => NO_TUI,
    },
  };
}
