import { useEffect, useState } from "react";
import { SafeAreaView, Pressable, Text, View, StyleSheet } from "react-native";
import Purchases from "react-native-purchases";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { StyleScreen } from "./src/screens/StyleScreen";
import { RateScreen } from "./src/screens/RateScreen";
import { PaywallScreen } from "./src/screens/PaywallScreen";
import { SignUpScreen } from "./src/screens/SignUpScreen";
import { loadRemoteFilters } from "./src/lib/remoteFilters";
import { logReceiptEnvironment } from "./src/lib/receipts";
import { useSession } from "./src/api/auth";

type Tab = "style" | "credits" | "pro";

export default function App() {
  const session = useSession();
  const [onboarded, setOnboarded] = useState(false);
  const [tab, setTab] = useState<Tab>("style");

  useEffect(() => {
    Purchases.configure({ apiKey: "appl_kQ8rT2nVfXbW4yZ1" });
    loadRemoteFilters().catch(() => undefined);
    logReceiptEnvironment().catch(() => undefined);
  }, []);

  if (!onboarded) return <OnboardingScreen onDone={() => setOnboarded(true)} />;
  if (!session) return <SignUpScreen />;

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.body}>
        {tab === "style" && <StyleScreen />}
        {tab === "credits" && <RateScreen />}
        {tab === "pro" && <PaywallScreen />}
      </View>
      <View style={styles.tabs}>
        {(["style", "credits", "pro"] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
            <Text style={tab === t ? styles.active : undefined}>{t.toUpperCase()}</Text>
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
