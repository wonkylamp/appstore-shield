import Purchases from "react-native-purchases";

/**
 * Logs which StoreKit environment validated the active entitlement, so support can tell
 * sandbox purchases from real ones in crash and billing reports. It changes no behaviour.
 */
export async function logReceiptEnvironment(): Promise<void> {
  const info = await Purchases.getCustomerInfo();
  const entitlement = info.entitlements.active["pro"];
  if (!entitlement) return;
  if (entitlement.isSandbox) {
    console.log("[receipts] entitlement validated against sandbox", entitlement.productIdentifier);
  } else {
    console.log("[receipts] entitlement validated against production", entitlement.productIdentifier);
  }
}
