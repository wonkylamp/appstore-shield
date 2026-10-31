import { assertReflectionsEnabled } from "../config/killswitch";

const API = "https://api.inkwell.app";

export interface Reflection {
  id: string;
  text: string;
}

export class FlaggedError extends Error {}

/** Our server moderates the entry and the reflection; the app never calls a model provider directly. */
export async function reflect(entry: string, token: string): Promise<Reflection> {
  await assertReflectionsEnabled();
  const res = await fetch(`${API}/v1/reflect`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entry }),
  });
  if (res.status === 422) throw new FlaggedError("This entry can't be reflected on because it goes against our content rules.");
  if (!res.ok) throw new Error(`Server error ${res.status}`);
  return (await res.json()) as Reflection;
}

export type ReportTarget = { kind: "reflection" | "prompt"; id: string };

export async function report(target: ReportTarget, reason: string, token: string): Promise<void> {
  await fetch(`${API}/v1/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...target, reason }),
  });
}

export async function blockUser(userId: string, token: string): Promise<void> {
  await fetch(`${API}/v1/blocks/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface SharedPrompt {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
}

export async function communityPrompts(token: string): Promise<SharedPrompt[]> {
  const res = await fetch(`${API}/v1/prompts`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? ((await res.json()) as SharedPrompt[]) : [];
}
