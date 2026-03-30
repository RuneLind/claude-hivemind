/**
 * Service registration, health polling, and log baseline management.
 */

import type { Database } from "bun:sqlite";
import type { ServiceInfo, DashboardMessage } from "../shared/types.ts";
import type { BrokerContext } from "./db.ts";
import { getAllPeers, type PeerStatements } from "./peers.ts";

export function createServiceStatements(db: Database) {
  return {
    upsertService: db.prepare(`
      INSERT INTO services (peer_id, port, health_url, log_file, log_format, status, last_check)
      VALUES (?, ?, ?, ?, ?, 'unknown', NULL)
      ON CONFLICT(peer_id) DO UPDATE SET
        port = excluded.port, health_url = excluded.health_url,
        log_file = excluded.log_file, log_format = excluded.log_format
    `),
    selectAllServices: db.prepare(`SELECT * FROM services`),
    selectServiceByPeer: db.prepare(`SELECT * FROM services WHERE peer_id = ?`),
    updateServiceStatus: db.prepare(
      `UPDATE services SET status = ?, last_check = ? WHERE peer_id = ?`
    ),
    deleteServiceByPeer: db.prepare(`DELETE FROM services WHERE peer_id = ?`),
    upsertBaseline: db.prepare(`
      INSERT INTO log_baselines (namespace, baseline_at) VALUES (?, ?)
      ON CONFLICT(namespace) DO UPDATE SET baseline_at = excluded.baseline_at
    `),
    deleteBaseline: db.prepare(`DELETE FROM log_baselines WHERE namespace = ?`),
    selectAllBaselines: db.prepare(`SELECT * FROM log_baselines`),
    upsertBaselineOffset: db.prepare(`
      INSERT INTO log_baseline_offsets (namespace, peer_id, file_offset) VALUES (?, ?, ?)
      ON CONFLICT(namespace, peer_id) DO UPDATE SET file_offset = excluded.file_offset
    `),
    deleteBaselineOffsets: db.prepare(`DELETE FROM log_baseline_offsets WHERE namespace = ?`),
    selectBaselineOffset: db.prepare(
      `SELECT file_offset FROM log_baseline_offsets WHERE namespace = ? AND peer_id = ?`
    ),
  };
}

export type ServiceStatements = ReturnType<typeof createServiceStatements>;

let polling = false;

export async function pollServiceHealth(
  ctx: BrokerContext,
  peerStmts: PeerStatements,
  svcStmts: ServiceStatements,
): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const services = svcStmts.selectAllServices.all() as ServiceInfo[];
    if (services.length === 0) return;

    const peerIds = new Set(getAllPeers(peerStmts).map((p) => p.id));

    await Promise.all(
      services.map(async (svc) => {
        if (!peerIds.has(svc.peer_id)) {
          svcStmts.deleteServiceByPeer.run(svc.peer_id);
          return;
        }
        let newStatus: "up" | "down";
        try {
          const res = await fetch(`http://127.0.0.1:${svc.port}${svc.health_url}`, {
            signal: AbortSignal.timeout(3000),
          });
          newStatus = res.ok ? "up" : "down";
        } catch {
          newStatus = "down";
        }
        if (newStatus === svc.status) return;
        const now = new Date().toISOString();
        svcStmts.updateServiceStatus.run(newStatus, now, svc.peer_id);
        const updated: ServiceInfo = { ...svc, status: newStatus, last_check: now };
        ctx.server.publish(
          "dashboard",
          JSON.stringify({ type: "service_update", service: updated } satisfies DashboardMessage)
        );
      })
    );
  } finally {
    polling = false;
  }
}
