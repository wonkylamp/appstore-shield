import { useState } from "react";
import { View, Text, Pressable, Alert, Linking, Modal, StyleSheet } from "react-native";
import { deleteAccount, signOut } from "../auth/account";
import { useConsent } from "../config/consent";
import { PaywallScreen } from "./PaywallScreen";

export function SettingsScreen() {
  const consent = useConsent();
  const [showPaywall, setShowPaywall] = useState(false);

  function confirmDelete() {
    Alert.alert("Delete account?", "This permanently deletes your account and all journal entries.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete account",
        style: "destructive",
        onPress: () => deleteAccount().catch(() => Alert.alert("Couldn't delete your account", "Please try again or contact support.")),
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={() => setShowPaywall(true)}><Text style={styles.row}>Inkwell Plus</Text></Pressable>
      <Pressable onPress={consent.revoke}><Text style={styles.row}>Stop sharing entries with OpenAI</Text></Pressable>
      <Pressable onPress={() => Linking.openURL("mailto:support@inkwell.app")}><Text style={styles.row}>Contact support</Text></Pressable>
      <Pressable onPress={() => Linking.openURL("https://inkwell.app/privacy")}><Text style={styles.row}>Privacy Policy</Text></Pressable>
      <Pressable onPress={signOut}><Text style={styles.row}>Sign out</Text></Pressable>
      <Pressable onPress={confirmDelete}><Text style={[styles.row, styles.danger]}>Delete account</Text></Pressable>
      <Modal visible={showPaywall} animationType="slide">
        <PaywallScreen onClose={() => setShowPaywall(false)} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  row: { paddingVertical: 14, fontSize: 16 },
  danger: { color: "#b91c1c" },
});
