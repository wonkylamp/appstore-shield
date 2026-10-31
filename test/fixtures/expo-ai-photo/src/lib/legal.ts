import Purchases from "react-native-purchases";

/**
 * Generative AI services offered to users in mainland China need a filing (CAC
 * algorithm registration) we do not hold, so generation is switched off for the
 * China storefront. This is described in the review notes for every version.
 */
export async function generationAllowedInRegion(): Promise<boolean> {
  const storefront = await Purchases.getStorefront();
  if (storefront?.countryCode === "CHN") {
    return false;
  }
  return true;
}
