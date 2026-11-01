import { useState } from "react";
import { View, Text, Image, Pressable, ScrollView, ActivityIndicator, StyleSheet } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { restylePhoto } from "../api/fal";
import { fetchPromptConfig } from "../api/promptClient";
import { useFeatureFlag } from "../hooks/useFeatureFlag";
import { availablePresets, BASE_PRESETS, type StylePreset } from "../presets";
import { generationAllowedInRegion } from "../lib/legal";

export function StyleScreen() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const presets = useFeatureFlag("nsfw_presets") ? availablePresets() : BASE_PRESETS;

  async function pickPhoto() {
    const picked = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.8 });
    const asset = picked.assets?.[0];
    if (!picked.canceled && asset?.base64) setPhoto(`data:image/jpeg;base64,${asset.base64}`);
  }

  async function apply(preset: StylePreset) {
    if (!photo) return;
    if (!(await generationAllowedInRegion())) return;
    setBusy(true);
    try {
      const config = await fetchPromptConfig();
      const url = await restylePhoto({ imageUrl: photo, prompt: `${config.prefix} ${preset.prompt}` });
      setResult(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Pressable onPress={pickPhoto} style={styles.picker}>
        {photo ? <Image source={{ uri: photo }} style={styles.preview} /> : <Text>Choose a photo</Text>}
      </Pressable>
      <View style={styles.grid}>
        {presets.map((p) => (
          <Pressable key={p.id} onPress={() => apply(p)} style={styles.chip}>
            <Text>{p.label}</Text>
          </Pressable>
        ))}
      </View>
      {busy && <ActivityIndicator />}
      {result && <Image source={{ uri: result }} style={styles.result} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  picker: { height: 220, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "#eee" },
  preview: { width: "100%", height: "100%", borderRadius: 16 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: "#f2e8ff" },
  result: { width: "100%", aspectRatio: 3 / 4, borderRadius: 16 },
});
