import { useEffect, useState } from "react";
import { FlatList, View, Text, StyleSheet } from "react-native";
import { blockUser, communityPrompts, report, type SharedPrompt } from "../api/client";
import { useAccount } from "../auth/account";

/** Prompt packs shared by other users (user-generated content, Guideline 1.2). */
export function CommunityScreen() {
  const { user } = useAccount();
  const [prompts, setPrompts] = useState<SharedPrompt[]>([]);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (user) communityPrompts(user.token).then(setPrompts);
  }, [user]);

  function onBlock(authorId: string) {
    if (!user) return;
    setBlocked((prev) => new Set(prev).add(authorId));
    blockUser(authorId, user.token);
  }

  return (
    <FlatList
      data={prompts.filter((p) => !blocked.has(p.authorId))}
      keyExtractor={(p) => p.id}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Text style={styles.text}>{item.text}</Text>
          <Text style={styles.author}>by {item.authorName}</Text>
          <View style={styles.actions}>
            <Text style={styles.action} onPress={() => user && report({ kind: "prompt", id: item.id }, "user_report", user.token)}>
              Report
            </Text>
            <Text style={styles.action} onPress={() => onBlock(item.authorId)}>
              Block user
            </Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  text: { fontSize: 16 },
  author: { color: "#666" },
  actions: { flexDirection: "row", gap: 16 },
  action: { color: "#b91c1c" },
});
