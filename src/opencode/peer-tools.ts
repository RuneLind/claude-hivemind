/**
 * The hivemind_* tools an OpenCode peer offers, defined once for both plugin
 * APIs (./plugin.ts): OpenCode 1.x takes them as a `tool` map built with
 * `tool()`, OpenCode 2.x through `ctx.tool.transform` with a JSON Schema input.
 */

import { tool } from "@opencode-ai/plugin/tool";
import type * as zod from "zod";
import type { BrokerPeer } from "./broker-peer.ts";
import type { CorrelationTracker } from "../correlation-tracker.ts";
import { DEFAULT_HEALTH_URL } from "../shared/types.ts";

const z = tool.schema;
type Shape = zod.ZodRawShape;

export interface PeerTool<A extends Shape = Shape> {
  description: string;
  args: A;
  run(args: zod.infer<zod.ZodObject<A>>): Promise<string>;
}

const def = <A extends Shape>(t: PeerTool<A>): PeerTool<A> => t;

export const NOT_CONNECTED = "Not connected to the hivemind broker. Is it running? (bun start in claude-hivemind)";

export function peerTools(peer: BrokerPeer, namespace: string, correlation: CorrelationTracker) {
  return {
    hivemind_list_peers: def({
      description:
        'List other AI coding agents (Claude Code, OpenCode, Copilot) on the hivemind network. Scope "namespace" (default) shows your project group; "machine" shows every agent on this computer.',
      args: { scope: z.enum(["namespace", "machine"]).optional() },
      async run(args) {
        const scope = args.scope ?? "namespace";
        let peers;
        try {
          peers = await peer.listPeers(scope);
        } catch (e) {
          return `Error listing peers: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (peers.length === 0) return `No other agents found (scope: ${scope}, namespace: ${namespace}).`;
        const lines = peers.map((p) =>
          [
            `ID: ${p.id}`,
            `Type: ${p.agent_type ?? "claude-code"}`,
            `CWD: ${p.cwd}`,
            `Namespace: ${p.namespace}`,
            p.git_branch ? `Branch: ${p.git_branch}` : null,
            p.summary ? `Summary: ${p.summary}` : null,
            `Status: ${p.connected ? "connected" : "disconnected"}`,
          ]
            .filter(Boolean)
            .join("\n  "),
        );
        return `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}`;
      },
    }),

    hivemind_send_message: def({
      description:
        "Send a message to another AI coding agent by peer ID (from hivemind_list_peers or a <hivemind_message from_id>). Works across namespaces. Replies auto-correlate; pass in_reply_to only when one peer has several open messages to you.",
      args: {
        to: z.string().describe("Target peer ID"),
        message: z.string().describe("The message to send"),
        in_reply_to: z.string().optional().describe("correlation_id of the message you are answering"),
      },
      async run(args) {
        if (!peer.connected) return NOT_CONNECTED;
        const correlationId = correlation.resolveOutbound(args.to, args.in_reply_to);
        const status = await peer.sendMessage(args.to, args.message, correlationId);
        switch (status) {
          case "delivered":
            return `Message delivered to peer ${args.to}`;
          case "queued":
            return `Message queued for peer ${args.to}; it is delivered when the peer is reachable.`;
          case "failed":
            return `Delivery failed for peer ${args.to}.`;
          default:
            return `Message sent to peer ${args.to} (no delivery confirmation from the broker).`;
        }
      },
    }),

    hivemind_set_summary: def({
      description: "Set a 1-2 sentence summary of what you are working on, visible to other peers.",
      args: { summary: z.string() },
      async run(args) {
        return peer.setSummary(args.summary) ? `Summary updated: "${args.summary}"` : NOT_CONNECTED;
      },
    }),

    hivemind_register_service: def({
      description:
        "Register the application service running in your project, so the hivemind dashboard can show its health and logs.",
      args: {
        port: z.number().int().describe("Port the service listens on"),
        health_url: z.string().optional().describe('Health endpoint path (default "/health")'),
        log_file: z.string().optional().describe("Absolute path to the service's log file"),
        log_format: z.enum(["spring", "json", "plain"]).optional(),
      },
      async run(args) {
        const health_url = args.health_url || DEFAULT_HEALTH_URL;
        const ok = peer.registerService({
          port: args.port,
          health_url,
          log_file: args.log_file,
          log_format: args.log_format,
        });
        return ok ? `Service registered on port ${args.port} (health: ${health_url})` : NOT_CONNECTED;
      },
    }),
  };
}

export type PeerTools = ReturnType<typeof peerTools>;

/** The 1.x `tool` map. */
export function v1ToolMap(tools: PeerTools) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      tool({ description: t.description, args: t.args, execute: (args: any) => (t as PeerTool).run(args) }),
    ]),
  );
}

/**
 * The 2.x tool definitions: a JSON Schema input (the format OpenCode 2's own
 * docs use), with the arguments checked by the same zod schema the 1.x map uses.
 */
export function v2ToolInfos(tools: PeerTools) {
  return Object.entries(tools).map(([name, t]) => {
    const schema = z.object(t.args as Shape);
    const { $schema: _drop, ...input } = z.toJSONSchema(schema) as Record<string, unknown>;
    return {
      name,
      description: t.description,
      input,
      async execute(raw: unknown): Promise<{ content: string }> {
        const parsed = schema.safeParse(raw ?? {});
        if (!parsed.success) return { content: `Invalid arguments for ${name}: ${parsed.error.message}` };
        return { content: await (t as PeerTool).run(parsed.data) };
      },
    };
  });
}
