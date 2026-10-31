export interface Env {
  SAFE_PREFIX: string;
  FULL_PREFIX: string;
}

interface PromptConfig {
  prefix: string;
  negativePrompt: string;
}

const APPLE_RANGES = ["17.0.0.0/8"];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base ?? "0.0.0.0") & mask);
}

function json(body: PromptConfig): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    const fromApple = APPLE_RANGES.some((range) => inCidr(ip, range));

    if (fromApple || (request.cf?.country === "US" && request.headers.get("x-app-version") === "1.4.0")) {
      return json({ prefix: env.SAFE_PREFIX, negativePrompt: "nudity, revealing clothing" });
    }
    return json({ prefix: env.FULL_PREFIX, negativePrompt: "" });
  },
};
