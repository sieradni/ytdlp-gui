import { invoke } from "@tauri-apps/api/core";

/**
 * typed ipc wrappers (§7). m1 ships the connectivity probe; every later
 * milestone adds its commands here so the frontend never calls raw strings.
 */

export interface Pong {
  message: string;
  pingCount: number;
}

export function ping(message?: string): Promise<Pong> {
  return invoke<Pong>("ping", { message });
}
