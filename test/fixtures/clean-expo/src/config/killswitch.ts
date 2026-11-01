import remoteConfig from "@react-native-firebase/remote-config";

export class ReflectionsPausedError extends Error {
  constructor() {
    super("AI reflections are paused right now. Please try again later.");
  }
}

let fetched: Promise<boolean> | undefined;

/** Lets us switch AI reflections off during an outage or abuse wave; it never enables anything. */
export async function assertReflectionsEnabled(): Promise<void> {
  fetched ??= remoteConfig()
    .setDefaults({ generation_killswitch: false })
    .then(() => remoteConfig().fetchAndActivate());
  await fetched;
  if (remoteConfig().getValue("generation_killswitch").asBoolean()) {
    throw new ReflectionsPausedError();
  }
}
