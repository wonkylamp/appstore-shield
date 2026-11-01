import { useEffect, useState } from "react";
import remoteConfig from "@react-native-firebase/remote-config";

const DEFAULTS = {
  nsfw_presets: false,
  daily_free_generations: 3,
};

let ready: Promise<void> | undefined;

function ensureFetched(): Promise<void> {
  ready ??= remoteConfig()
    .setDefaults(DEFAULTS)
    .then(() => remoteConfig().fetchAndActivate())
    .then(() => undefined);
  return ready;
}

export function useFeatureFlag(key: keyof typeof DEFAULTS): boolean {
  const [value, setValue] = useState(Boolean(DEFAULTS[key]));
  useEffect(() => {
    ensureFetched().then(() => setValue(remoteConfig().getValue(key).asBoolean()));
  }, [key]);
  return value;
}

export async function dailyFreeGenerations(): Promise<number> {
  await ensureFetched();
  return remoteConfig().getValue("daily_free_generations").asNumber();
}
