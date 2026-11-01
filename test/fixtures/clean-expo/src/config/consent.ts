import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";

const KEY = "ai_consent_v1";

/** Consent to share journal text with OpenAI (Guideline 5.1.2(i)); asked before first use, revocable in Settings. */
export function useConsent() {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(KEY).then((v) => setGranted(v === "yes"));
  }, []);

  return {
    granted,
    grant: () => {
      setGranted(true);
      SecureStore.setItemAsync(KEY, "yes");
    },
    revoke: () => {
      setGranted(false);
      SecureStore.deleteItemAsync(KEY);
    },
  };
}
