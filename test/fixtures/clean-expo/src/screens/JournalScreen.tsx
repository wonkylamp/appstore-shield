import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert, StyleSheet } from "react-native";
import * as StoreReview from "expo-store-review";
import { reflect, report, type Reflection } from "../api/client";
import { useAccount } from "../auth/account";

let savedEntries = 0;

export function JournalScreen() {
  const { user } = useAccount();
  const [entry, setEntry] = useState("");
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onReflect() {
    if (!user) return;
    setError(null);
    try {
      setReflection(await reflect(entry, user.token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  async function onSave() {
    savedEntries += 1;
    setEntry("");
    if (savedEntries === 5 && (await StoreReview.hasAction())) {
      await StoreReview.requestReview();
    }
  }

  function onReport(r: Reflection) {
    if (!user) return;
    Alert.alert("Report this reflection?", "Our team reviews reports within 24 hours.", [
      { text: "Cancel", style: "cancel" },
      { text: "Report", style: "destructive", onPress: () => report({ kind: "reflection", id: r.id }, "user_report", user.token) },
    ]);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.prompt}>What made today different from yesterday?</Text>
      <TextInput multiline value={entry} onChangeText={setEntry} style={styles.input} placeholder="Start writing…" />
      <View style={styles.row}>
        <Pressable onPress={onSave} style={styles.button}><Text>Save</Text></Pressable>
        <Pressable onPress={onReflect} style={styles.button}><Text>Reflect with AI</Text></Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {reflection && (
        <View style={styles.card}>
          <Text>{reflection.text}</Text>
          <Text style={styles.report} onPress={() => onReport(reflection)}>Report</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  prompt: { fontSize: 20, fontWeight: "600" },
  input: { minHeight: 160, borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 12, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 12 },
  button: { padding: 12, borderRadius: 10, backgroundColor: "#eef" },
  error: { color: "crimson" },
  card: { padding: 14, borderRadius: 12, backgroundColor: "#f7f7f7", gap: 8 },
  report: { color: "#b91c1c", alignSelf: "flex-end" },
});
