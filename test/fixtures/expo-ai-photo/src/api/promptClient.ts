export interface PromptConfig {
  prefix: string;
  negativePrompt: string;
}

const PROMPT_URL = "https://prompt-router.glowup-app.workers.dev/v1/prompt-config";

export async function fetchPromptConfig(): Promise<PromptConfig> {
  const res = await fetch(PROMPT_URL, { headers: { "x-app-version": "1.4.0" } });
  if (!res.ok) return { prefix: "", negativePrompt: "" };
  return (await res.json()) as PromptConfig;
}
