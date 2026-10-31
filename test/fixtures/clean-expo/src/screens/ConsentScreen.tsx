import { View, Text, Pressable, Linking, StyleSheet } from "react-native";

export function ConsentScreen({ onAgree }: { onAgree: () => void }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Before you start</Text>
      <Text style={styles.body}>
        To write a reflection, Inkwell sends the journal entry you choose to our server, which passes it to OpenAI, a
        third-party AI provider. OpenAI uses it only to generate the reflection.
      </Text>
      <Text style={styles.muted}>
        Nothing is shared until you agree. You can withdraw consent at any time in Settings, which turns reflections off.
      </Text>
      <Text style={styles.link} onPress={() => Linking.openURL("https://inkwell.app/privacy")}>
        Privacy Policy
      </Text>
      <Pressable onPress={onAgree} style={styles.cta}>
        <Text style={styles.ctaText}>I agree, share my entries with OpenAI</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", gap: 14 },
  title: { fontSize: 26, fontWeight: "700" },
  body: { fontSize: 16 },
  muted: { fontSize: 14, color: "#666" },
  link: { color: "#2563eb" },
  cta: { marginTop: 20, backgroundColor: "#111", padding: 16, borderRadius: 14 },
  ctaText: { color: "white", textAlign: "center", fontWeight: "600" },
});
