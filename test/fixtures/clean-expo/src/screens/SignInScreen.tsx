import { View, Text, StyleSheet } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { signInWithApple } from "../auth/account";

export function SignInScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Inkwell</Text>
      <Text style={styles.body}>A daily prompt and a moment to reflect.</Text>
      <AppleAuthentication.AppleAuthenticationButton
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
        buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={12}
        style={styles.button}
        onPress={() => signInWithApple().catch(() => undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", gap: 16 },
  title: { fontSize: 32, fontWeight: "800" },
  body: { fontSize: 16, color: "#444" },
  button: { height: 48 },
});
