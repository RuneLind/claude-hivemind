import { writeFileSync, mkdirSync } from "node:fs";

const MSG_DIR = "/tmp/hm-msg";
let fileCounter = 0;

/**
 * Format an incoming peer message for cmux terminal delivery.
 * Short messages are typed inline; long ones are written to a file the agent can Read.
 */
export function formatPeerPrompt(
  fromId: string,
  text: string,
  fromSummary?: string | null,
): string {
  if (text.length <= 200) {
    return `[from ${fromId}] ${text}`;
  }
  try {
    mkdirSync(MSG_DIR, { recursive: true });
    const msgFile = `${MSG_DIR}/${Date.now()}-${++fileCounter}.md`;
    const header = `Message from ${fromId}${fromSummary ? ` — ${fromSummary}` : ""}`;
    writeFileSync(msgFile, `# ${header}\n\n${text}\n`);
    return `[from ${fromId}] Read ${msgFile}`;
  } catch {
    return `[from ${fromId}] ${text.slice(0, 200)}`;
  }
}
