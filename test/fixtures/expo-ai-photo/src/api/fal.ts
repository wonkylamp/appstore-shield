const FAL_KEY = process.env.EXPO_PUBLIC_FAL_KEY ?? "";
const MODEL = "fal-ai/flux/dev/image-to-image";

export interface RestyleRequest {
  /** data: URI or https URL of the user's own photo */
  imageUrl: string;
  prompt: string;
  strength?: number;
}

export async function restylePhoto({ imageUrl, prompt, strength = 0.85 }: RestyleRequest): Promise<string> {
  const res = await fetch(`https://fal.run/${MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      image_url: imageUrl,
      prompt,
      strength,
      num_inference_steps: 40,
      enable_safety_checker: false,
    }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}`);
  const json = (await res.json()) as { images: { url: string }[] };
  const first = json.images[0];
  if (!first) throw new Error("fal returned no image");
  return first.url;
}
