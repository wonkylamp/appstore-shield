import { useEffect, useState } from "react";
import { SafeAreaView, View, Pressable, Text, StyleSheet } from "react-native";
import * as Updates from "expo-updates";
import Purchases from "react-native-purchases";
import { useAccount } from "./src/auth/account";
import { useConsent } from "./src/config/consent";
import { SignInScreen } from "./src/screens/SignInScreen";
import { ConsentScreen } from "./src/screens/ConsentScreen";
import { JournalScreen } from "./src/screens/JournalScreen";
import { CommunityScreen } from "./src/screens/CommunityScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";

type Tab = "journal" | "community" | "settings";

async function applyBugfixUpdate() {
  const result = await Updates.checkForUpdateAsync();
  if (result.isAvailable) {
    await Updates.fetchUpdateAsync();
  }
}

export default function App() {
  const account = useAccount();
  const consent = useConsent();
  const [tab, setTab] = useState<Tab>("journal");

  useEffect(() => {
    Purchases.configure({ apiKey: "appl_Zx4mP9qLw2Rt7Ys1" });
    if (!__DEV__) applyBugfixUpdate().catch(() => undefined);
  }, []);

  if (!account.user) return <SignInScreen />;
  if (!consent.granted) return <ConsentScreen onAgree={consent.grant} />;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        {tab === "journal" && <JournalScreen />}
        {tab === "community" && <CommunityScreen />}
        {tab === "settings" && <SettingsScreen />}
      </View>
      <View style={styles.tabs}>
        {(["journal", "community", "settings"] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
            <Text style={tab === t ? styles.active : undefined}>{t}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, padding: 14, alignItems: "center" },
  active: { fontWeight: "700" },
});
