import { useState } from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { addCredits, getCredits } from "../lib/credits";

const REVIEW_URL = "itms-apps://apps.apple.com/app/id6740012345?action=write-review";

export function RateScreen() {
  const [credits, setCredits] = useState(getCredits());

  async function rateForCredits() {
    await Linking.openURL(REVIEW_URL);
    setCredits(addCredits(10));
  }

  return (
    <View style={styles.container}>
      <Text style={styles.balance}>{credits} credits</Text>
      <Pressable onPress={rateForCredits} style={styles.cta}>
        <Text style={styles.ctaText}>Rate us 5 stars to unlock 10 credits</Text>
      </Pressable>
      <Text style={styles.help} onPress={() => Linking.openURL("mailto:help@glowup-app.com")}>
        Questions? help@glowup-app.com
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 20, justifyContent: "center" },
  balance: { fontSize: 32, fontWeight: "700", textAlign: "center" },
  cta: { backgroundColor: "#7c3aed", padding: 16, borderRadius: 14 },
  ctaText: { color: "white", fontWeight: "600", textAlign: "center" },
  help: { textAlign: "center", color: "#666" },
});
