import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class FlaggedError extends Error {}

async function assertAllowed(text: string): Promise<void> {
  const result = await openai.moderations.create({ model: "omni-moderation-latest", input: text });
  if (result.results.some((r) => r.flagged)) throw new FlaggedError("flagged");
}

/** Moderates the user's text before the model sees it and the reply before the user sees it. */
export async function compose(text: string, tone: string): Promise<string> {
  await assertAllowed(text);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `Rewrite the user's text in a ${tone} tone. Keep the meaning. Refuse requests for sexual, hateful or violent content.` },
      { role: "user", content: text },
    ],
    max_tokens: 800,
  });
  const reply = completion.choices[0]?.message.content ?? "";

  await assertAllowed(reply);
  return reply;
}
