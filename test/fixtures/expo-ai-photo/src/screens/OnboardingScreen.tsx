import { View, Text, Pressable, StyleSheet } from "react-native";

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Restyle any photo in seconds</Text>
      <Text style={styles.proof}>4.9★ from 10,000 users</Text>
      <Text style={styles.body}>Pick a photo, choose a style, and GlowUp does the rest.</Text>
      <Pressable onPress={onDone} style={styles.cta}>
        <Text style={styles.ctaText}>Get started</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", gap: 12 },
  title: { fontSize: 28, fontWeight: "800" },
  proof: { fontSize: 16, color: "#b45309" },
  body: { fontSize: 16, color: "#444" },
  cta: { marginTop: 24, backgroundColor: "#111", padding: 16, borderRadius: 14 },
  ctaText: { color: "white", textAlign: "center", fontWeight: "600" },
});
