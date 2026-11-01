import { View } from "react-native";
import RevenueCatUI from "react-native-purchases-ui";

/** RevenueCat's hosted paywall renders localized prices, terms and restore itself. */
export function PaywallScreen() {
  return (
    <View style={{ flex: 1 }}>
      <RevenueCatUI.Paywall options={{ displayCloseButton: true }} />
    </View>
  );
}
