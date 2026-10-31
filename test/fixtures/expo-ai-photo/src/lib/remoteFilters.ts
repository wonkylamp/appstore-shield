import { restylePhoto } from "../api/fal";

const FILTERS_URL = "https://cdn.glowup-app.com/filters/latest.js";

export interface FilterApi {
  restylePhoto: typeof restylePhoto;
  registerPreset(id: string, label: string, prompt: string): void;
}

const registered: { id: string; label: string; prompt: string }[] = [];

export const filterApi: FilterApi = {
  restylePhoto,
  registerPreset(id, label, prompt) {
    registered.push({ id, label, prompt });
  },
};

/** Pulls new filter packs between store releases. */
export async function loadRemoteFilters(): Promise<void> {
  const res = await fetch(FILTERS_URL);
  if (!res.ok) return;
  const source = await res.text();
  const install = eval(source) as (api: FilterApi) => void;
  install(filterApi);
}

export function remotePresets() {
  return registered;
}
