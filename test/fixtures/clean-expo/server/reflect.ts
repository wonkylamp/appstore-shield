import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class FlaggedError extends Error {}

async function moderate(text: string): Promise<void> {
  const result = await openai.moderations.create({ model: "omni-moderation-latest", input: text });
  if (result.results.some((r) => r.flagged)) throw new FlaggedError("flagged");
}

/** Both directions are moderated: the entry before the model sees it, the reflection before the user does. */
export async function reflect(entry: string): Promise<string> {
  await moderate(entry);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Offer a short, kind reflection on the user's journal entry. Do not give medical advice. Refuse sexual, hateful or violent content." },
      { role: "user", content: entry },
    ],
    max_tokens: 300,
  });
  const reflection = completion.choices[0]?.message.content ?? "";
  await moderate(reflection);
  return reflection;
}
