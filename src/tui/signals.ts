import { createSignal } from "solid-js";

export const statusSignals = new Map<string, ReturnType<typeof createSignal<string>>>();

export function getStatusSignal(sessionID: string) {
  if (!statusSignals.has(sessionID)) {
    statusSignals.set(sessionID, createSignal<string>("idle"));
  }
  return statusSignals.get(sessionID)!;
}
