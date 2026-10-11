import { CloudCheck } from "lucide-react";
import type { MomentResponse } from "../../api/generated/types.gen";

/**
 * Marks an entry that was written on the device first (the Capture outbox) and
 * then confirmed by the server. The server sets `client_id` only for those, so
 * the marker is a fact the API returned, never inferred (DESIGN.md principle 6).
 *
 * Shared by the Timeline row and the document header, which the reader and the
 * editor both use (docs/features/pwa.md, "Offline capture and sync").
 */
export function DeviceOrigin({
  moment,
}: {
  moment?: Pick<MomentResponse, "client_id">;
}) {
  if (!moment?.client_id) return null;
  return (
    <span
      className="jv-meta jv-origin"
      title="Written on this device, then saved to your journal"
    >
      <CloudCheck aria-hidden="true" size={13} />
      Synced from device
    </span>
  );
}
