import { useEffect, useState } from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import Purchases, { PACKAGE_TYPE, type PurchasesPackage } from "react-native-purchases";

function periodLabel(pkg: PurchasesPackage): string {
  switch (pkg.packageType) {
    case PACKAGE_TYPE.MONTHLY:
      return "per month";
    case PACKAGE_TYPE.ANNUAL:
      return "per year";
    default:
      return "";
  }
}

export function PaywallScreen({ onClose }: { onClose: () => void }) {
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);

  useEffect(() => {
    Purchases.getOfferings().then((o) => setPackages(o.current?.availablePackages ?? []));
  }, []);

  return (
    <View style={styles.container}>
      <Pressable onPress={onClose} accessibilityLabel="Close" style={styles.close}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
      <Text style={styles.title}>Inkwell Plus</Text>
      <Text style={styles.body}>Unlimited reflections, prompt packs and export.</Text>
      {packages.map((pkg) => (
        <Pressable key={pkg.identifier} style={styles.option} onPress={() => Purchases.purchasePackage(pkg)}>
          <Text style={styles.optionTitle}>{pkg.product.title}</Text>
          <Text>
            {pkg.product.priceString} {periodLabel(pkg)}
          </Text>
        </Pressable>
      ))}
      <Text style={styles.terms}>
        Subscriptions auto-renew until cancelled. Cancel any time in your Apple Account settings at least 24 hours
        before the end of the current period.
      </Text>
      <Pressable onPress={() => Purchases.restorePurchases()}>
        <Text style={styles.link}>Restore Purchases</Text>
      </Pressable>
      <View style={styles.links}>
        <Text style={styles.link} onPress={() => Linking.openURL("https://inkwell.app/terms")}>Terms of Use</Text>
        <Text style={styles.link} onPress={() => Linking.openURL("https://inkwell.app/privacy")}>Privacy Policy</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, justifyContent: "center" },
  close: { position: "absolute", top: 16, right: 16, padding: 8 },
  closeText: { fontSize: 20 },
  title: { fontSize: 28, fontWeight: "800" },
  body: { fontSize: 16, color: "#444" },
  option: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: "#ddd" },
  optionTitle: { fontWeight: "600" },
  terms: { fontSize: 12, color: "#666" },
  links: { flexDirection: "row", gap: 16 },
  link: { color: "#2563eb" },
});
