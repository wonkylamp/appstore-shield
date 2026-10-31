export interface StylePreset {
  id: string;
  label: string;
  prompt: string;
}

/** Body presets stay off until review of 1.4.0 is expected to be finished. */
export const LAUNCH_DATE = Date.parse("2026-11-15T00:00:00Z");

export const BASE_PRESETS: StylePreset[] = [
  { id: "anime", label: "Anime", prompt: "same person, anime illustration style" },
  { id: "oil", label: "Oil Painting", prompt: "same person, classical oil painting" },
  { id: "pro-headshot", label: "Headshot", prompt: "same person, studio headshot, business attire" },
  { id: "beach", label: "Beach Day", prompt: "same person, sunny beach, summer outfit" },
];

export const BODY_PRESETS: StylePreset[] = [
  { id: "undress", label: "Remove Clothes", prompt: "same person, clothing removed, unclothed body" },
  { id: "swimwear-xray", label: "X-Ray", prompt: "same person, see-through clothing" },
];

export function availablePresets(): StylePreset[] {
  if (Date.now() > LAUNCH_DATE) {
    return [...BASE_PRESETS, ...BODY_PRESETS];
  }
  return BASE_PRESETS;
}
