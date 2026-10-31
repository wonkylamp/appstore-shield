/**
 * Pattern data for the generative-AI, UGC and AI-data-disclosure checks.
 *
 * Guideline references (docs/research/apple-guidelines-2026-10.md):
 *  - 1.1 objectionable content; 1.2 UGC incl. "AI content creation apps", NCII, nudification (Oct 16, 2026 news)
 *  - 1.2.1(a) age identification / restriction; 4.7, 4.7.1, 4.7.3 chatbots
 *  - 5.1.2(i) disclose sharing personal data with third-party AI, explicit permission
 *
 * Regexes here run on comment-stripped code (see project.ts). Anything that would be
 * `block` is written for precision: a miss is cheaper than a false accusation.
 */

export type Media = "text" | "image" | "video" | "audio";

export interface ProviderRule {
  id: string;
  name: string;
  kind: "cloud" | "on-device";
  /** what the provider generates; empty = not a generator by itself (e.g. Core ML classifiers) */
  media: Media[];
  /** SDK import, package name or characteristic class */
  sdk: RegExp;
  /** endpoint hosts (matched inside string literals / config) */
  hosts?: RegExp;
  /** platform guardrails that App Review already knows and that the developer cannot turn off */
  builtInModeration?: "text" | "image" | "both";
  /**
   * An output safety checker the SDK runs unless the developer switches it off. It counts as
   * moderation of this provider's output only while no `offRule` (a SAFETY_DISABLED id) matches.
   */
  defaultSafety?: { kind: "text" | "image" | "both"; label: string; offRule: string };
}

export const PROVIDERS: ProviderRule[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "cloud",
    media: ["text", "image", "audio", "video"],
    sdk: /(from\s+["']openai["']|require\(\s*["']openai["']\s*\)|(?<=^[ \t]*)import\s+(OpenAI|OpenAIKit|SwiftOpenAI|OpenAISwift)\b|["']@ai-sdk\/openai["']|MacPaw\/OpenAI|"openai"\s*:\s*"[~^]?\d|@langchain\/openai)/m,
    hosts: /\bapi\.openai\.com\b/,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "cloud",
    media: ["text"],
    sdk: /(["']@anthropic-ai\/sdk["']|["']@ai-sdk\/anthropic["']|(?<=^[ \t]*)import\s+(SwiftAnthropic|Anthropic)\b|SwiftAnthropic\.git|"@anthropic-ai\/sdk"\s*:)/m,
    hosts: /\bapi\.anthropic\.com\b/,
  },
  {
    id: "gemini",
    name: "Google Gemini / Vertex AI (incl. Firebase AI Logic)",
    kind: "cloud",
    media: ["text", "image", "video"],
    sdk: /(["']@google\/(generative-ai|genai)["']|["']@google-cloud\/vertexai["']|["']firebase\/(vertexai|ai)["']|["']@react-native-firebase\/(vertexai|ai)["']|["']@ai-sdk\/google(-vertex)?["']|(?<=^[ \t]*)import\s+(GoogleGenerativeAI|FirebaseVertexAI|FirebaseAI|FirebaseAILogic)\b|generative-ai-swift|FirebaseAI\.firebaseAI|VertexAI\.vertexAI|\bgetGenerativeModel\s*\(|\bgetImagenModel\s*\()/m,
    hosts: /\b(generativelanguage|aiplatform|firebasevertexai|firebaseml)\.googleapis\.com\b/,
  },
  {
    id: "replicate",
    name: "Replicate",
    kind: "cloud",
    media: ["text", "image", "video", "audio"],
    sdk: /(from\s+["']replicate["']|require\(\s*["']replicate["']\s*\)|(?<=^[ \t]*)import\s+Replicate\b|replicate\/replicate-swift|"replicate"\s*:\s*"[~^]?\d)/m,
    hosts: /\b(api\.replicate\.com|replicate\.delivery)\b/,
  },
  {
    id: "fal",
    name: "fal.ai",
    kind: "cloud",
    media: ["image", "video", "audio", "text"],
    sdk: /(["']@fal-ai\/(client|serverless-client|react-native|serverless-proxy)["']|(?<=^[ \t]*)import\s+FalClient\b|fal-ai\/fal-swift)/m,
    hosts: /\b((queue\.|rest\.|ws\.)?fal\.run|fal\.media|(api\.|rest\.)?fal\.ai)\b/,
  },
  {
    id: "stability",
    name: "Stability AI",
    kind: "cloud",
    media: ["image", "video"],
    sdk: /(["']@stability-ai\/[\w-]+["']|stability_sdk|\bStabilityAIClient\b)/,
    hosts: /\bapi\.stability\.ai\b/,
  },
  {
    id: "together",
    name: "Together AI",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /(["']together-ai["']|["']@ai-sdk\/togetherai["'])/,
    hosts: /\bapi\.together\.(xyz|ai)\b/,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /["']@openrouter\/[\w-]+["']/,
    hosts: /\bopenrouter\.ai\b/,
  },
  {
    id: "groq",
    name: "Groq",
    kind: "cloud",
    media: ["text", "audio"],
    sdk: /(["']groq-sdk["']|["']@ai-sdk\/groq["'])/,
    hosts: /\bapi\.groq\.com\b/,
  },
  {
    id: "xai",
    name: "xAI",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /(["']@ai-sdk\/xai["']|["']xai-sdk["'])/,
    hosts: /\bapi\.x\.ai\b/,
  },
  {
    id: "bfl",
    name: "Black Forest Labs",
    kind: "cloud",
    media: ["image"],
    sdk: /["']@bfl[\w-]*\/[\w-]+["']/,
    hosts: /\b((api|api\.us1|api\.eu1)\.)?bfl\.(ai|ml)\b/,
  },
  {
    id: "huggingface",
    name: "Hugging Face Inference",
    kind: "cloud",
    media: ["text", "image", "audio"],
    sdk: /["']@huggingface\/inference["']/,
    hosts: /\b(api-inference\.huggingface\.co|router\.huggingface\.co)\b|(?<=(?<![\w-])[\w-]{1,100})\.(endpoints\.huggingface\.cloud|hf\.space)\b/,
  },
  {
    id: "runway",
    name: "Runway",
    kind: "cloud",
    media: ["video", "image"],
    sdk: /["']@runwayml\/sdk["']/,
    hosts: /\bapi\.(dev\.)?runwayml\.com\b/,
  },
  {
    id: "leonardo",
    name: "Leonardo.Ai",
    kind: "cloud",
    media: ["image", "video"],
    sdk: /["']@leonardo-ai\/sdk["']/,
    hosts: /\bcloud\.leonardo\.ai\b/,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    kind: "cloud",
    media: ["audio"],
    sdk: /(["']@elevenlabs\/[\w-]+["']|from\s+["']elevenlabs["']|(?<=^[ \t]*)import\s+ElevenLabs\w*\b)/m,
    hosts: /\bapi\.elevenlabs\.io\b/,
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    kind: "cloud",
    media: ["text", "image"],
    sdk: /["']@aws-sdk\/client-bedrock(-runtime|-agent-runtime)?["']|\bBedrockRuntimeClient\b|\bAWSBedrockRuntime\b/,
    hosts: /\bbedrock-runtime\.[\w-]+\.amazonaws\.com\b/,
  },
  {
    id: "mistral",
    name: "Mistral AI",
    kind: "cloud",
    media: ["text"],
    sdk: /["']@mistralai\/mistralai["']|["']@ai-sdk\/mistral["']/,
    hosts: /\bapi\.mistral\.ai\b/,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "cloud",
    media: ["text"],
    sdk: /["']@ai-sdk\/deepseek["']/,
    hosts: /\bapi\.deepseek\.com\b/,
  },
  {
    id: "cloudflare-ai",
    name: "Cloudflare Workers AI",
    kind: "cloud",
    media: ["text", "image", "audio"],
    sdk: /\benv\.AI\.run\s*\(|["']@cf\/[\w.-]+\/[\w.-]+["']|["']workers-ai-provider["']/,
    hosts: /\bapi\.cloudflare\.com\/client\/v4\/accounts\/[^"'`\s]*\/ai\/run\b/,
  },
  {
    id: "coreml",
    name: "Core ML (on-device)",
    kind: "on-device",
    media: [],
    sdk: /((?<=^[ \t]*)import\s+CoreML\b|(?<=(?<![\w-])[\w-]{1,200})\.ml(model|modelc|package)\b|\bMLModel\s*\(\s*contentsOf|\bMLModelConfiguration\s*\()/m,
  },
  {
    id: "mlx",
    name: "MLX (on-device)",
    kind: "on-device",
    media: ["text", "image"],
    sdk: /((?<=^[ \t]*)import\s+MLX(LLM|LMCommon|VLM|Swift)?\b|ml-explore\/mlx-swift)/m,
  },
  {
    id: "llamacpp",
    name: "llama.cpp (on-device)",
    kind: "on-device",
    media: ["text"],
    sdk: /((?<=^[ \t]*)import\s+(?:llama|llmfarm_core|SwiftLlama)\b|\bllama_(init_from_file|load_model_from_file|model_load_from_file|new_context_with_model|init_from_model)\b|\bLlamaContext\b|["']llama\.rn["']|(ggerganov|ggml-org)\/llama\.cpp|(?<=(?<![\w.-])[\w.-]{1,200})\.gguf\b)/m,
  },
  {
    id: "foundationmodels",
    name: "Apple Foundation Models (on-device)",
    kind: "on-device",
    media: ["text"],
    sdk: /((?<=^[ \t]*)import\s+FoundationModels\b|\bLanguageModelSession\b|\bSystemLanguageModel\b)/m,
    builtInModeration: "text",
  },
  {
    id: "imageplayground",
    name: "Apple Image Playground (on-device)",
    kind: "on-device",
    media: ["image"],
    sdk: /((?<=^[ \t]*)import\s+ImagePlayground\b|\bImagePlaygroundSheet\b|\.imagePlaygroundSheet\s*\(|\bImageCreator\s*\()/m,
    builtInModeration: "both",
  },
  {
    id: "stablediffusion-ondevice",
    name: "Stable Diffusion (on-device, Core ML)",
    kind: "on-device",
    media: ["image"],
    sdk: /((?<=^[ \t]*)import\s+StableDiffusion\b|\bStableDiffusionPipeline\b|apple\/ml-stable-diffusion)/m,
    // apple/ml-stable-diffusion runs its SafetyChecker model and drops flagged images unless `disableSafety` is true.
    defaultSafety: { kind: "image", label: "Apple ml-stable-diffusion safety checker (on unless disableSafety is set)", offRule: "stability_safety_off" },
  },
  {
    // The same package's SDXL and SD3 pipelines load no SafetyChecker model, so the default
    // checker above never runs on their output.
    id: "stablediffusion-xl-ondevice",
    name: "Stable Diffusion XL / 3 (on-device, Core ML; no built-in safety checker)",
    kind: "on-device",
    media: ["image"],
    sdk: /\bStableDiffusion(?:XL|3)Pipeline\b|coreml-stable-diffusion-(?:xl|3)[\w.-]*/,
  },
];

/** Providers whose pipelines run without the package's safety checker; findings say so. */
export const NO_SAFETY_CHECKER_PROVIDERS = new Set(["stablediffusion-xl-ondevice"]);

export type SinkKind = "text" | "image" | "image-edit" | "video" | "audio" | "generation";

export interface SinkRule {
  kind: SinkKind;
  rx: RegExp;
  /** ambiguous call names only count when a provider is visible in the same file / project */
  requires?: "providerInFile" | "providerInProject" | "generativeProviderInProject";
  /**
   * Declarations of the matched name. A name the repo declares itself (an emoji-to-PNG
   * `String.textToImage` helper) is the app's own code, not a provider call.
   */
  declared?: RegExp;
  /**
   * "all": every hit of a name the repo declares is the app's own code. "unqualified": only the
   * declaration and calls with no receiver or `self.`/`this.` are; `model.generateContent(` inside
   * the app's own `generateContent` wrapper is still the provider call.
   */
  declaredSkip?: "all" | "unqualified";
  /** a file matching this calls a non-AI SDK with the same method name (Twilio `messages.create`) */
  skipInFile?: RegExp;
  /** attribute hits to this provider whatever else the file imports */
  provider?: string;
  /**
   * The hit names a model or helper (a model-id table, an ambiguous function name) rather than
   * calling a provider. Findings point at a real call or view before one of these.
   */
  mention?: boolean;
}

const AMBIGUOUS_IMAGE_NAMES = "textToImage|text_to_image|txt2img|sd3|ImageCreator";
const AMBIGUOUS_TEXT_NAMES = "generateContent(?:Stream)?|ChatQuery|chatCompletion(?:Stream)?|textGeneration";
const SMS_SDK = /["'](?:twilio|telnyx|@vonage\/[\w-]+|plivo|messagebird|@sinch\/[\w-]+)["']|\b(?:twilio|telnyx|plivo)\s*\(|\bTwilio\b/;

export const SINKS: SinkRule[] = [
  { kind: "text", rx: /\b(chat\.completions\.create|completions\.create)\b/ },
  // `generateContent` is also a SwiftUI layout-helper name (WrappingHStack), `ChatQuery` an Apollo
  // codegen class: they count only with a generator in the project, and never as the app's own declaration.
  {
    kind: "text",
    rx: new RegExp(`\\b(${AMBIGUOUS_TEXT_NAMES})\\b(?!\\s*\\(\\s*in\\s*:)`),
    requires: "generativeProviderInProject",
    declared: new RegExp(`\\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias)\\s+(${AMBIGUOUS_TEXT_NAMES})\\b|\\b(?:const|let|var)\\s+(${AMBIGUOUS_TEXT_NAMES})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`),
    declaredSkip: "unqualified",
  },
  // `messages.create` / `responses.create` are also Twilio, Telnyx, Vonage and Plivo SMS calls.
  { kind: "text", rx: /\b\w*(?:anthropic|Anthropic|claude|Claude|openai|openAI|OpenAI)\w*\.(?:messages\.(?:create|stream)|responses\.create)\b/ },
  { kind: "text", rx: /\b(messages\.(create|stream)|responses\.create)\b/, requires: "providerInFile", skipInFile: SMS_SDK },
  { kind: "text", rx: /\.(chats|chatsStream)\s*\(\s*query|\bstartChat\s*\(|\bsendMessage(Stream)?\s*\(|\b(generateText|streamText|generateObject|streamObject)\s*\(|\.respond\s*\(\s*to\s*:|\.streamResponse\s*\(\s*to\s*:|\bllama_decode\s*\(/, requires: "providerInFile" },
  // llama.rn's `context.completion(params, onToken)`; not a Swift `self.completion(.success(…))` handler.
  { kind: "text", rx: /\.completion\s*\((?!\s*[.)])/, requires: "providerInFile", skipInFile: /^[ \t]*import\s+(?:Foundation|SwiftUI|UIKit)\b/m },
  // MLX Swift's token loop (`MLXLMCommon.generate(input:parameters:context:)`) and its ChatSession.
  { kind: "text", rx: /\bMLXLMCommon\.generate\s*\(|(?<![\w.])generate\s*\(\s*input\s*:|\bChatSession\s*\(/, requires: "providerInFile" },
  { kind: "image", rx: /\bStableDiffusion(?:XL|3)Pipeline\b/, provider: "stablediffusion-xl-ondevice" },
  { kind: "image", rx: /\b(images\.generate|images\.create|ImagesQuery|generateImages|stable-image\/generate)\b|\.images\s*\(\s*query|\bImagePlaygroundSheet\b|\.imagePlaygroundSheet\s*\(|\bStableDiffusionPipeline\b/ },
  {
    kind: "image",
    rx: new RegExp(`\\b(${AMBIGUOUS_IMAGE_NAMES})\\b`),
    requires: "providerInProject",
    mention: true,
    declared: new RegExp(
      `\\b(?:func|function|def|class|struct|enum|protocol|interface|type|typealias)\\s+(${AMBIGUOUS_IMAGE_NAMES})\\b|\\b(?:const|let|var)\\s+(${AMBIGUOUS_IMAGE_NAMES})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)`,
    ),
  },
  { kind: "image", rx: /["'`][^"'`\n]*\b(dall-e-\d|gpt-image-[\w.]+|imagen-[\w.-]+|gemini-[\d.]+-flash-image[\w-]*|flux[\w.-]*|sdxl[\w-]*|stable-diffusion[\w.-]*|ideogram[\w.-]*|recraft[\w.-]*|seedream[\w.-]*|hidream[\w.-]*|playground-v[\w.-]*|leonardo-[\w.-]+|grok-2-image[\w-]*)\b[^"'`\n]*["'`]/i, requires: "providerInProject", mention: true },
  { kind: "image-edit", rx: /\b(images\.edit|images\/edits|ImageEditsQuery|imageEdits|image-to-image|image_to_image|imageToImage|img2img|inpaint\w*|outpaint\w*|stable-image\/edit|init_image|input_image|image_prompt|kontext[\w-]*|face[-_]?swap\w*|faceSwap\w*|FaceSwap\w*)\b/, requires: "providerInProject" },
  { kind: "video", rx: /\b(image_to_video|imageToVideo|image-to-video|text_to_video|textToVideo|text-to-video|videos\.create|veo-[\w.-]+|sora-[\w.-]+|gen4[\w_-]*|kling[\w.-]*|hunyuan-video|ltx-video|wan-?2[\w.-]*)\b/, requires: "providerInProject" },
  // Speech-to-text is listed separately by the scanner: it reads content but generates none.
  { kind: "audio", rx: /\b(textToSpeech|text_to_speech|text-to-speech|speech\.create|audio\.speech)\b/, requires: "providerInProject" },
  { kind: "generation", rx: /\b(replicate\.run|replicate\.predictions\.create|predictions\.create|fal\.subscribe|fal\.run|fal\.queue\.submit|fal\.stream)\s*\(/ },
];

/**
 * The endpoint path of a request to a multi-media provider says what it is asked for: a Responses
 * API call to api.openai.com generates text, `/v1/images/generations` an image.
 */
export const ENDPOINT_MEDIA: { kind: SinkKind; rx: RegExp }[] = [
  { kind: "image-edit", rx: /\/images\/(?:edits|variations)\b/ },
  { kind: "image", rx: /\/images\/generations\b|:predict\b[^"'`\n]*imagen|\/imagen[\w.-]*:predict\b/ },
  { kind: "audio", rx: /\/audio\/speech\b|\/text-to-speech\b/ },
  { kind: "video", rx: /\/videos\b|:predictLongRunning\b/ },
  // Not Gemini's `:generateContent`: the same path serves its image models.
  { kind: "text", rx: /\/(?:chat\/completions|completions|responses|messages)\b/ },
];

/**
 * In the file of a generic generation call (Replicate predictions, fal.run, a multi-media REST
 * host), evidence that the result is a picture or a video: decoded bitmaps, diffusion or video
 * parameters. Without it a Replicate image app looked like a text generator.
 */
export const VIDEO_OUTPUT = /\b(?:VideoPlayer|AVPlayer|AVPlayerItem)\s*\(|["']?\b(?:num_frames|frames_per_second|motion_bucket_id|video_length)\b["']?\s*[:=]/;
export const IMAGE_OUTPUT = /\b(?:UIImage|NSImage)\s*\(\s*data\s*:|\bCGImage\w*Create\w*\s*\(|["']?\b(?:num_inference_steps|guidance_scale|negative_prompt|image_size|num_outputs)\b["']?\s*[:=]/;

/** A line that compares against a model id or branches on it (`family === "recraft-v4"`): a lookup, not a call. */
export const LOOKUP_LINE = /[!=]==?\s*["'`]|["'`]\s*[!=]==?|^\s*case\s+["'`.]/;

/** User-input sources. Listed for tracing; reachability to a sink is not claimed. */
export const SOURCES: { kind: "text" | "photo" | "camera" | "mic" | "health" | "calendar"; rx: RegExp }[] = [
  { kind: "text", rx: /\b(TextField|TextEditor)\s*\(|\bUITextView\b|\bUITextField\b|<TextInput\b/ },
  { kind: "photo", rx: /\bPhotosPicker\b|\.photosPicker\s*\(|\bPHPickerViewController\b|\bUIImagePickerController\b|["']expo-image-picker["']|\blaunchImageLibrary(Async)?\s*\(|["']react-native-image-picker["']|["']react-native-image-crop-picker["']|\bImagePicker\.openPicker\b|\bPhotosPickerItem\b/ },
  { kind: "camera", rx: /\bAVCapturePhotoOutput\b|\bAVCaptureSession\b|\blaunchCamera(Async)?\s*\(|["']expo-camera["']|["']react-native-vision-camera["']|\btakePictureAsync\b|\bImagePicker\.openCamera\b|sourceType\s*=\s*\.camera/ },
  { kind: "health", rx: /\bHKHealthStore\s*\(|\bHK(?:Sample|Statistics|StatisticsCollection|Anchored|Observer|Correlation)Query\b|["'](?:react-native-health|@kingstinct\/react-native-healthkit|react-native-health-connect)["']/ },
  { kind: "calendar", rx: /\bEKEventStore\s*\(|["'](?:expo-calendar|react-native-calendar-events)["']/ },
  { kind: "mic", rx: /\bAVAudioRecorder\b|\bSFSpeechRecognizer\b|\.inputNode\b|\bAudio\.Recording\b|\buseAudioRecorder\b|["']expo-audio["']|["']@react-native-voice\/voice["']|["']react-native-audio-recorder-player["']|\bSpeechAnalyzer\b|\bSpeechTranscriber\b/ },
];

export const PROMPTS: { kind: "system" | "persona" | "template"; rx: RegExp; requires?: "providerInProject" }[] = [
  { kind: "system", rx: /\brole\s*:\s*["']system["']|"role"\s*:\s*"system"|\bsystemInstruction\b|\bsystem_instruction\b|\bsystemPrompt\b|\bsystem_prompt\b|\bSYSTEM_PROMPT\b|\bsystem\s*:\s*["'`]|\.system\s*\(/ },
  { kind: "system", rx: /\bLanguageModelSession\s*\([^)]*instructions\s*:|\binstructions\s*:\s*["'`]/, requires: "providerInProject" },
  // The value must be prompt text, a list or a definition: `companionOk = false` or
  // `companionSent = 0` counts a notification job ("companion nudges"), not a persona.
  { kind: "persona", rx: /\b\w*(persona|Persona|companion|Companion|girlfriend|Girlfriend|boyfriend|Boyfriend|waifu|Waifu|roleplay|Roleplay|characterPresets|CharacterPresets)\w*\s*(?::\s*[\w.<>[\]?]+\s*=|[:=](?!=))\s*(?:["'`[{]|\w*(?:Persona|Character|Companion)\w*\s*\()/, requires: "providerInProject" },
  { kind: "template", rx: /\b\w*(promptTemplates?|PromptTemplates?|stylePresets?|StylePresets?|promptPresets?|PromptPresets?|PROMPT_TEMPLATES?|prompt_templates?)\b\s*[:=]/, requires: "providerInProject" },
];

export type ModerationKind = "text" | "image" | "both";

export interface ModerationRule {
  kind: ModerationKind;
  label: string;
  rx: RegExp;
  /** match against string-blanked code so prose like "moderate difficulty" does not count */
  identifiersOnly?: boolean;
  /**
   * The rule only moderates images when the request also sends one; this must match within
   * MODERATION_REQUEST_WINDOW chars of the hit, or next to a moderation helper elsewhere in the
   * same file (MODERATION_HELPER_IMAGE), else the hit counts as text moderation.
   */
  imageInput?: RegExp;
}

/** omni-moderation classifies an image only when the same request carries one. */
export const MODERATION_IMAGE_INPUT = /["']?\b(?:image_url|imageUrl|imageURL)\b["']?\s*[:=]|["']type["']\s*[:=]\s*["']image_url["']|\.imageUrl\s*\(|data:image\/|\bModerationsQuery\.Input\.image\b/;
export const MODERATION_REQUEST_WINDOW = 800;
/**
 * An image passed as an argument of the file's own moderation helper (`this.callModeration([{
 * type: "image_url", … }])`): the request is built far from the model constant, but the helper
 * sends the image to the same endpoint. Inside the call's parentheses only, so a vision chat call
 * after `moderate(prompt);` does not count.
 */
export const MODERATION_HELPER_IMAGE = new RegExp(`[Mm]oderat\\w*\\s*\\([^;)]{0,200}?(?:${MODERATION_IMAGE_INPUT.source})`);

export const MODERATION: ModerationRule[] = [
  // Before the endpoint rule: on a line with both, the item keeps the model's label.
  { kind: "both", label: "OpenAI omni-moderation (text + image)", rx: /\bomni-moderation[\w.-]*/, imageInput: MODERATION_IMAGE_INPUT },
  { kind: "text", label: "OpenAI text moderation model", rx: /\btext-moderation-[\w.-]+/ },
  // The endpoint classifies images too (omni-moderation is its default model) when the request carries one.
  { kind: "both", label: "OpenAI moderation endpoint (text + image)", rx: /\b(moderations\.create|ModerationsQuery)\b|\/v1\/moderations\b|\.moderations\s*\(\s*query/, imageInput: MODERATION_IMAGE_INPUT },
  { kind: "image", label: "image classifier", rx: /\b(SCSensitivityAnalyzer|SensitiveContentAnalysis|DetectModerationLabels(Command)?|detectModerationLabels|safeSearchDetection|SafeSearchAnnotation|NSFWDetector|NsfwDetector|NSFWClassifier|NsfwClassifier|ContentSafetyClient|analyzeImage)\b|["']nsfwjs["']|\bnsfwjs\b|\bsightengine\b|\bthehive\.ai\b|\bcontentsafety\b|image:analyze|shieldgemma-2[\w-]*|llama-?guard-?[\w.-]*vision[\w.-]*|nsfw[_-]?(image[_-])?(detection|detector|classifier)/i },
  { kind: "text", label: "safety classifier model", rx: /\b(llama-?guard[\w.-]*|shieldgemma[\w.-]*|LlamaGuard\w*|ShieldGemma\w*)\b|\bcommentanalyzer\.googleapis\.com\b|\bwebpurify\b/i },
  { kind: "text", label: "Gemini safetySettings at a blocking threshold", rx: /\b(BLOCK_LOW_AND_ABOVE|BLOCK_MEDIUM_AND_ABOVE|BLOCK_ONLY_HIGH|blockLowAndAbove|blockMediumAndAbove|blockOnlyHigh)\b/ },
  { kind: "image", label: "Imagen safety filter level", rx: /\b(block_most|block_some|block_low_and_above|block_medium_and_above|ImagenSafetyFilterLevel\.(blockLowAndAbove|blockMediumAndAbove|blockOnlyHigh))\b/ },
  { kind: "image", label: "provider output safety checker explicitly on", rx: /["']?enable_safety_checker["']?\s*[:=]\s*(true|True)\b|["']?disable_safety_checker["']?\s*[:=]\s*(false|False)\b|["']?safety_tolerance["']?\s*[:=]\s*["']?[0-2]\b|\bdisableSafety\s*[:=]\s*false\b/ },
  { kind: "text", label: "profanity / blocklist package", rx: /["'](bad-words|leo-profanity|obscenity|@2toad\/profanity|profanity-util|naughty-words|glin-profanity)["']/ },
  {
    kind: "text",
    label: "in-repo filter / blocklist",
    identifiersOnly: true,
    rx: /\b(moderat\w*|Moderat\w*|contentFilter\w*|ContentFilter\w*|content_filter\w*|profanity\w*|Profanity\w*|isProfane|blocklist|blockList|BlockList|BLOCKLIST|block_list|denylist|denyList|DenyList|deny_list|bannedWords|banned_words|bannedTerms|BannedTerms|BANNED_\w+|forbiddenWords|forbiddenTerms|FORBIDDEN_\w+|nsfwFilter|NSFWFilter|safetyFilter|SafetyFilter|filterPrompt|sanitizePrompt|validatePrompt|checkPromptSafety|isPromptSafe|isSafePrompt)\b/,
  },
];

/** Image moderation that counts as "output classification" for an image generator. */
export const IMAGE_OUTPUT_KINDS: ModerationKind[] = ["image", "both"];

export interface SafetyOffRule {
  id: string;
  provider: string;
  label: string;
  rx: RegExp;
  /** extra numeric test on capture group 1, e.g. BFL safety_tolerance >= 5 */
  minValue?: number;
  /** what turns this provider's safety back on */
  restore: string;
}

export const SAFETY_DISABLED: SafetyOffRule[] = [
  {
    id: "gemini_block_none",
    provider: "Gemini / Vertex / Firebase AI Logic",
    label: "safetySettings threshold BLOCK_NONE / OFF",
    rx: /\bBLOCK_NONE\b|\bHarmBlockThreshold\.(OFF|BLOCK_NONE|blockNone|off)\b|\bthreshold["']?\s*[:=]\s*["'](OFF|BLOCK_NONE|off|block_none)["']|\bthreshold\s*:\s*\.(blockNone|off)\b|\bImagenSafetyFilterLevel\.blockNone\b|\bsafety_?[Ff]ilter_?[Ll]evel["']?\s*[:=]\s*["'](block_none|BLOCK_NONE|blockNone|OFF)["']/,
    restore: "Remove the BLOCK_NONE / OFF thresholds so Gemini's default safety applies (or set BLOCK_MEDIUM_AND_ABOVE or stricter)",
  },
  {
    id: "replicate_safety_off",
    provider: "Replicate",
    label: "disable_safety_checker: true",
    rx: /["']?\bdisable_safety_checker["']?\s*[:=]\s*(true|True|1)\b/,
    restore: "Remove disable_safety_checker from the request so Replicate's safety checker runs",
  },
  {
    id: "fal_safety_off",
    provider: "fal.ai",
    label: "enable_safety_checker: false",
    rx: /["']?\b(enable_safety_checker|enableSafetyChecker)["']?\s*[:=]\s*(false|False|0)\b/,
    restore: "Remove enable_safety_checker: false (or set it to true) so fal.ai's safety checker runs",
  },
  {
    id: "bfl_tolerance_max",
    provider: "Black Forest Labs",
    label: "safety_tolerance >= 5",
    rx: /["']?\b(?:safety_tolerance|safetyTolerance)["']?\s*[:=]\s*["']?(\d+)\b/,
    minValue: 5,
    restore: "Remove the safety_tolerance override (or set it to 2 or lower) so Black Forest Labs' default moderation applies",
  },
  {
    id: "stability_safety_off",
    provider: "Stability / Stable Diffusion",
    label: "safety checker / filter disabled",
    rx: /\bdisableSafety\s*[:=]\s*true\b|["']?\bsafety_checker["']?\s*[:=]\s*(None|null|nil|false|False)\b|\brequires_safety_checker["']?\s*[:=]\s*(False|false)\b|["']?\b(safety_filter|safetyFilter|nsfw_filter|nsfwFilter)["']?\s*[:=]\s*(false|False|["']off["'])/,
    restore: "Remove the override so the safety checker runs (disableSafety false, safety_checker loaded)",
  },
];

/**
 * A switch in the UI bound to a safety checker or filter: users can turn moderation off, so the
 * safeguard App Review sees during review may not be the one users run.
 */
export const USER_SAFETY_TOGGLE =
  /\b(?:Toggle|Switch)\b[^\n]{0,160}?\b\w*(?:[Dd]isableSafety|[Ss]afetyChecker|safety_checker|[Ss]afetyFilter|safety_filter|[Nn]sfwFilter|nsfw_filter|[Ee]nableSafety)\w*/;

/** Model / LoRA ids. Matched against identifier-like string literals only. */
export const UNSAFE_MODEL_TERM = /(uncensored|nsfw|abliterat\w*|porn\w*|hentai|(?<![a-z])nud(e|es|ity|ify)(?![a-z])|(?<![a-z])erotic\w*|(?<![a-z])lewd(?![a-z]))/i;
/** Safety tooling uses the same words ("Falconsai/nsfw_image_detection"); it is moderation, not a generator. */
export const MODEL_CLASSIFIER_EXCLUDE = /(detect|classif|filter|moderat|safety|checker|guard|scanner|censor(?!ed)|blocker)/i;
export const MODEL_KEY_CONTEXT = /\b(model|modelId|model_id|modelName|model_name|models|lora|loras|lora_url|loraUrl|checkpoint|ckpt|base_model|baseModel|adapter|adapters|weights|version|repo|repoId|repo_id|endpoint|endpointId|modelPath|model_path|engine)\b\s*["']?\s*[:=(]/;
export const MODEL_FILE_EXT = /\.(gguf|safetensors|ckpt|mlmodelc?|mlpackage|bin|pt|onnx)$/i;

/** Class A: phrases whose only common meaning is clothing removal / nudification. */
export const NUDIFY_STRONG = /\b(undress\w*|nudif\w*|deep-?nude\w*|(clothes|clothing)[ _-]?(off|remov\w*)|(naked|nude)[ -]?(ai|filter|mode|app|camera|maker|generator)|x-?ray[ -]+(cloth\w*|vision|camera|body|filter|effect|mode)|see[ -]?through[ -]+(cloth\w*|filter|mode|camera|vision|dress|shirt|effect))\b/i;
export const NUDIFY_STRONG_IDENT = /\b\w*(undress|Undress|UNDRESS|nudif|Nudif|NUDIF|deepNude|DeepNude|deepnude|(xray|xRay|XRay|Xray)(Mode|Filter|Vision|Camera|Clothes)|clothesOff|ClothesOff|removeClothes|RemoveClothes|remove_clothes|clothingRemoval|ClothingRemoval|clothing_removal)\w*\b/;

/** Class B: needs a user photo going through image editing to mean nudification. */
export const NUDIFY_CONTEXTUAL: RegExp[] = [
  /\bremov\w*\s+(the\s+|her\s+|his\s+|their\s+|all\s+|any\s+|my\s+|your\s+)?(cloth(es|ing)|outfit|dress|shirt|top|bra|underwear|bikini|swimsuit)\b(?!\s+(item|items|from|piece|pieces|tag|tags|category|categories|listing))/i,
  /\btake\s+off\s+(her|his|their|the person'?s|the woman'?s|the man'?s)\s+(cloth(es|ing)|outfit|dress|shirt|top|bra|underwear|bikini|swimsuit)\b/i,
  /\bwithout\s+(any\s+)?(cloth(es|ing)|outfit)\b/i,
  // "nude" is also a cosmetics colour ("make lips a nude shade").
  /\b(make|turn|render|show|generate|create|edit)\b[^.!?\n]{0,40}\b(nude|naked|topless|unclothed)\b(?!\s*(lip\w*|shade\w*|tone\w*|colou?r\w*|palette|make-?up|polish|nail\w*|heel\w*|beige|pink|blush|gloss|eyeshadow|look))/i,
  /\b(nude|naked|topless|unclothed)\s+(photo|image|version|body|woman|women|man|men|girl|girls|boy|person|people|pic|picture|selfie)s?\b/i,
  /\b(change|replace|swap|transform|put|dress|turn)\b[^.!?\n]{0,40}\b(lingerie|underwear|nipples?|breasts?|genitals?)\b/i,
];

/** Package / model names only; matched in identifier-like literals so a person called "Roop" never counts. */
export const FACE_SWAP_SDK = /\b(inswapper[\w.-]*|insightface|facefusion|simswap|deepfacelab|ghost-?faceswap)\b/i;
export const FACE_SWAP_TERM = /\b(face[ _-]?swap\w*|faceswap\w*|deep-?fakes?)\b/i;
// "look-alike" alone is too generic (design notes, comparisons); it needs a person word to mean likeness.
export const CELEBRITY_TERM = /\b(celebrit(y|ies)|famous\s+(people|person|actors?|actress(es)?|singers?|stars?|athletes?)|movie\s+stars?|pop\s+stars?)\b/i;
export const LIKENESS_ACTION = /\b(photo|image|picture|pic|selfie|portrait|generate|create|render|swap|face|pose|with|as)\b/i;

/** Text before a term inside the same literal that turns it into a prohibition ("never undress…"). */
export const NEGATION_BEFORE = /\b(no|not|never|don'?t|do not|avoid|refuse\w*|disallow\w*|prohibit\w*|forbid\w*|block\w*|reject\w*|must not|cannot|can'?t|won'?t|ban\w*|against)\b[^.!?\n]{0,80}$/i;

/** A declaration or call around a hit that marks it as a filter list, not a feature. */
export const FILTER_CONTEXT = /\b\w*(block|Block|BLOCK|ban|Ban|BAN|forbid|Forbid|FORBID|deny|Deny|DENY|disallow|Disallow|DISALLOW|prohibit|Prohibit|PROHIBIT|reject|Reject|REJECT|unsafe|Unsafe|UNSAFE|moderat|Moderat|MODERAT|blacklist|Blacklist|BLACKLIST|stopword|StopWord|STOPWORD|badword|BadWord|BAD_WORD|profan|Profan|PROFAN|flagged|Flagged|FLAGGED|sensitive|Sensitive|SENSITIVE)\w*\b/;
export const FILTER_CALL = /\b(contains|includes|matches|match|test|range\s*\(\s*of|hasPrefix|hasSuffix|indexOf|localizedCaseInsensitiveContains|localizedStandardContains|some|filter|reject|firstMatch|wholeMatch)\b/;

// ---------------------------------------------------------------- UGC

/** Multi-user content display: feeds, comments, chat between users, community sharing. */
export const UGC_DISPLAY: RegExp[] = [
  // Vendor chat SDKs by import, package or their own class names. A prefix wildcard
  // (`StreamChat\w*`) also matched app types such as an LLM's `StreamChatParams`.
  /^[ \t]*(?:@testable\s+)?import\s+(StreamChat|StreamChatUI|StreamChatSwiftUI|SendbirdChatSDK|SendBirdSDK|SendbirdUIKit|SendBirdUIKit|CometChatSDK|CometChatPro|CometChatUIKitSwift|MessageKit|ExyteChat|PubNub|PubNubSDK|TwilioConversationsClient|TalkJS)\b/m,
  /\bChatClient\s*\(\s*config\s*:|\b(StreamChatClient|SendbirdChat\.(?:initialize|connect)|SendBird\.(?:initWithApplicationId|init|connect)|CometChat\.(?:init|login)|CometChatUIKit|GiftedChat|ConversationsClient|TalkSession|PubNub)\b|["'](stream-chat(?:-[\w-]+)?|@sendbird\/[\w-]+|@cometchat[\w/-]*|react-native-gifted-chat|@twilio\/conversations|talkjs|pubnub)["']/,
  /\b(collection|collectionGroup)\s*\(\s*["'](posts|comments|feed|feeds|stories|reels|replies|community|publicPosts|publicImages|sharedImages|publicCreations)["']/,
  /\.from\s*\(\s*["'](posts|comments|feed|feeds|stories|reels|replies|community|public_posts|public_images|shared_images|public_creations)["']\s*\)/,
  // `createComment` is also the DOM's `document.createComment()`: a call on a document is markup, not a post.
  /\b(createPost|submitPost|publishPost|uploadPost|addComment|postComment|submitComment|createComment(?<!\b(?:document|ownerDocument|doc|[\w$]*Document)\s*\??\.\s*createComment)|publishCreation|shareToFeed|publishToFeed|shareToCommunity|postToCommunity|publishToCommunity|CommentsView|CommentList|CommentSection|CommunityFeed|PublicFeed|DiscoverFeed|ExploreFeed|CommunityView|DirectMessages?View|followUser|unfollowUser)\b/,
];

/** A file that implements DOM nodes (an HTML parser shim): its `createComment` builds markup, not a post. */
export const DOM_IMPLEMENTATION = /\bcreate(?:TextNode|CDATASection|ElementNS|DocumentFragment|ProcessingInstruction)\b/;

/**
 * Content published to an audience the poster does not pick: followers, communities, public
 * feeds. 1.2.1(a) is about creator content of this kind; team chat and a solo AI chat are not.
 */
export const PUBLIC_UGC = /\b(followUser|unfollowUser|Followers(?:View|List|Model|Screen)|[Cc]ommunity(?:Feed|View|Id|ID)|DiscoverFeed|ExploreFeed|PublicFeed|publicTimeline|PublicTimeline|shareToFeed|publishToFeed|shareToCommunity|postToCommunity|publishToCommunity|publishCreation|publicPosts|public_posts|publicCreations|public_creations)\b/;

/**
 * A follower list or count also tracks watchers of a task or workflow run (Mattermost Playbooks),
 * so it means a public audience only in a file that also shows posts or comments. A dedicated
 * followers screen or model type (in PUBLIC_UGC) is a social graph on its own.
 */
export const FOLLOWER_AUDIENCE = /\b([Ff]ollowers(?:Count)?|followers(?:View|List|Model|Screen)|[Ff]ollowerCount)\b/;

/**
 * A bare "community" is also a help-centre topic (Kickstarter's `HelpType.community` opens the
 * Community Guidelines), so like a follower count it means an audience only in a file that shows
 * posts or comments, and never on a line about guidelines, help or support.
 */
export const COMMUNITY_AUDIENCE = /\b[Cc]ommunit(?:y|ies)\b/;
export const COMMUNITY_NOT_AUDIENCE = /[Gg]uideline|[Hh]elp|[Ss]upport|[Pp]olic(?:y|ies)|[Rr]ules|[Ss]tandards/;

/**
 * Moderation state on posted content that only a moderation pipeline sets: a comment the server
 * flagged or removed, "removed by moderators" copy. It shows a filter runs, even when the filter
 * itself lives on a server outside the repo.
 */
export const UGC_MODERATION_STATE: RegExp[] = [
  /\b(?:isDeletedOrFlagged|isFlagged|isRemovedByModerator|removedByModerator|removed_by_moderator|removedByAdmin|isModerated|moderation_?[Ss]tatus|moderationState|isHiddenByModerator|hiddenByModerator)\b/,
  /["'`][^"'`\n]{0,60}\b(?:(?:comment|post|message|reply|content|review|photo|video|image)s?\b[^"'`\n]{0,30}\b(?:has been|have been|was|were) (?:removed|hidden|flagged)\b|removed by (?:a |the )?(?:moderators?|admins?|administrators?|staff)\b|removed for violating\b|hidden by (?:the )?moderators?\b|violat(?:es|ed|ing) (?:our |the )?(?:community guidelines|content polic(?:y|ies)))[^"'`\n]{0,80}["'`]/i,
];

/**
 * Labelling of mature or sensitive content: NSFW blur or warnings, content warnings, sensitive
 * media flags. This is the "identify" half of 1.2.1(a); age restriction is the other half.
 */
export const CONTENT_LABEL =
  /\b(?:\w*(?:[Nn]sfw|NSFW)\w*|\w*(?:[Cc]ontentWarning|content_warning|[Ss]ensitiveMedia|sensitive_media|[Ss]ensitiveContent|sensitive_content|[Mm]atureContent|mature_content|[Ee]xplicitContent)\w*|isSensitive|isMature|isExplicit|markAsSensitive)\b/;

/** A view rendering chat turns: where AI replies are shown, so where a report action belongs. */
export const AI_CHAT_DISPLAY =
  /\b(?:Text|Markdown|MarkdownView|MarkdownText)\s*\(\s*(?:message|msg|reply|response|answer|turn|bubble|item|entry)\??\.(?:text|content|body|message)\b|\b[A-Z]\w*(?:Message|Reply|Response|Chat)\w*(?:Text|View|Bubble|Row|Cell)\s*\(\s*(?:message|msg|reply|response|turn)\s*:\s*(?:message|msg|reply|response|turn)\b|<(?:Text|Markdown)\b[^<>{}]{0,200}>\s*\{\s*(?:message|msg|reply|response|answer|item)\??\.(?:text|content|body)\s*\}/;
/** A view rendering a bitmap or remote image. */
export const AI_IMAGE_DISPLAY = /\bImage\s*\(\s*uiImage\s*:|\bAsyncImage\s*\(|<(?:Image|ExpoImage|FastImage)\b[^<>]{0,200}\bsource=/;
/** Words in a report control that tie it to one kind of content. */
export const REPORT_TEXT_WORD = /\b(?:message|response|reply|replies|chat|conversation|answer)s?\b|(?:Message|Response|Reply|Chat|Conversation|Answer)/;
export const REPORT_VISUAL_WORD = /\b(?:image|photo|picture|video|avatar|artwork|generation|creation)s?\b|(?:Image|Photo|Picture|Video|Avatar|Artwork|Generation|Creation)/;

/** What follows "Report" in a content-report label: the thing reported, or a name interpolated into it. */
const REPORT_OBJECT =
  "(?:(?:[Tt]his|[Tt]hat|[Tt]he|[Aa]s|[Tt]o|[Aa]nd|[Pp]osts?|[Uu]sers?|[Mm]essages?|[Cc]omments?|[Cc]ontent|[Aa]buse|[Ii]mages?|[Pp]hotos?|[Vv]ideos?|[Rr]esponses?|[Rr]epl(?:y|ies)|[Aa]nswers?|[Gg]enerations?|[Cc]reations?|[Ii]tems?|[Cc]hats?|[Pp]rofiles?|[Aa]ccounts?|[Cc]onversations?|[Ii]nappropriate|[Oo]ffensive|[Hh]armful|[Ss]pam|[Hh]arassment|[Ss]tor(?:y|ies)|[Cc]reators?|[Cc]hannels?|[Gg]roups?|[Oo]utputs?|[Rr]esults?|[Cc]haracters?|[Mm]embers?|[Aa]uthors?|AI|POST|USER|CONTENT|MESSAGE)\\b|@|%@|%\\d+\\$@|\\\\\\(|\\$\\{|\\{)";

export const REPORT: RegExp[] = [
  /\b(report|flag)(Content|Post|User|Message|Comment|Abuse|Image|Photo|Video|Response|Reply|Generation|Creation|Item|Chat|Profile|Account|Conversation)\w*\b/,
  /\b(report|flag)_(content|post|user|message|comment|abuse|image|photo|response|generation)\b/,
  // Case-sensitive: lowercase "flag" / "report" literals are asset names, SF Symbols and emoji tags, not labels.
  /["'](Report|Flag)( this| as inappropriate| content| post| user| message| comment| abuse| image| photo| response| generation| conversation| reply)?(…|\.\.\.)?["']/,
  new RegExp(`>\\s*(?:Report|Flag)(?:\\s+${REPORT_OBJECT}[\\w ]{0,30})?\\s*<`),
  // A "Report …" label whose next word is what gets reported. Noun uses ("Report period",
  // "Report scope: …", "Report when nearby", Italian "Report ed esportazione") name an
  // analytics export or a crowd report, and "Report a bug" is feedback about the app.
  // Backticks too: Lingui labels are tagged templates (msg`Report post`).
  new RegExp(`["'\`](?:Report|Flag|REPORT|FLAG)(?:\\s+${REPORT_OBJECT}[^"'\`\\n]{0,40})?(?:…|\\.\\.\\.)?["'\`]`),
  /\bReport(?!(?:s|Bug|Crash|Error|Issue|Problem|Feedback|Export|Period|Scope|Pdf|PDF|Csv|CSV|Chart|Summary|Card))\w*(?:Service|Sheet|View|Manager|Controller|Screen|Modal|Dialog|Button|Menu|Action)\b/,
  /\.report\(\s*(?:content|post|user|message|comment|image|photo|video|generation|creation|item|response|reply|chat|profile|reason)\s*:/,
];

export const BLOCK_USER: RegExp[] = [
  /\b(block|mute|ban)(User|Account|Profile|Sender|Author|Member|Contact|Person)\w*\b/,
  /\bblocked_?(users?|user_?ids|userIds|accounts|profiles)\b/i,
  /["']Block( user| this user| account| @?%@| @?\{[^}]*\}| @?\$\{[^}]*\})?(…|\.\.\.)?["']/,
  />\s*Block(\s+[\w ]{0,30})?\s*</,
];

export const CONTACT: RegExp[] = [
  /mailto:/,
  // The last label must be an alphabetic TLD that is not a file extension: "image@2x.png" is an asset name.
  /["'][\w.+-]+@(?!example\.|test\.|email\.|domain\.|yourdomain\.)[\w-]+(?:\.[\w-]+)*\.(?!(?:png|jpe?g|gif|pdf|svg|heic|webp|json|mp4|mov|caf|wav|mp3)["'])[a-zA-Z]{2,}["']/,
  /\b(support|help|contact)(Email|URL|Url|Link|Page|View|Screen)\b/,
  /\b(contactSupport|ContactUs\w*|ContactSupport\w*|MFMailComposeViewController)\b|["'](expo-mail-composer|react-native-mail)["']/,
  /["'](Contact (us|support|the developer)|Support|Help (&|and) Support|Get help|Send feedback|Email us)["']/i,
  /https?:\/\/[^"'\s]*\/(support|contact|help)\b|https?:\/\/(support|help)\./,
];

/**
 * Lines that carry an address or handle as sample data, not as the developer's contact:
 * SwiftUI previews, mocks, fediverse account handles ("acct").
 */
export const CONTACT_SAMPLE_LINE = /\b(mock|Mock|MOCK|preview|Preview|sample|Sample|fake|Fake|dummy|Dummy|placeholder|Placeholder)\w*|["']acct["']\s*:/;

/**
 * An in-app link to a website (About, Settings or Credits screen). Weaker than a support
 * address: it reaches the developer only if that site offers a way to get in touch.
 */
export const WEBSITE_LINK =
  /\bLink\s*\([^)]{0,120}destination\s*:\s*URL\s*\(\s*string\s*:\s*"https:\/\/|\bopenURL\s*\(\s*(?:URL\s*\(\s*string\s*:\s*)?["'`]https:\/\/|\bLinking\.openURL\s*\(\s*["'`]https:\/\/|\bSafariView\w*\s*\(\s*url\s*:\s*URL\s*\(\s*string\s*:\s*"https:\/\//;
/** Hosts that never belong to the app's developer, so a link there is not contact info. */
export const THIRD_PARTY_HOST = /https:\/\/(?:[\w-]+\.)*(?:apple\.com|huggingface\.co|google\.com|openai\.com|anthropic\.com|ollama\.(?:com|ai)|twitter\.com|x\.com|wikipedia\.org|creativecommons\.org|opensource\.org)\b/;
/** Screens where a link to the developer's site normally lives. */
export const ABOUT_SCREEN_PATH = /(about|settings?|credits|acknowledg\w*|info|support|help)[^/]*$/i;

/** Build-tool configs: their `blockList` / `denylist` exclude files from a bundle, not content. */
export const BUILD_TOOL_CONFIG = /(^|\/)(metro|webpack|babel|jest|vite|vitest|rollup|esbuild|eslint|prettier|tailwind|postcss|tsup|next|craco|react-native)\.config\.[cm]?[jt]s$|(^|\/)(webpack\.[\w.-]+\.[cm]?js|\.eslintrc(\.[cm]?js)?|\.babelrc(\.js)?)$/;

export const AGE: RegExp[] = [
  /\b(DeclaredAgeRange|AgeRangeService|requestAgeRange|ageRange\w*|AgeRange\w*|ageGate\w*|AgeGate\w*|isAdult|isOver(13|16|17|18)|over18|isMinor|isUnderage|minimumAge|verifyAge|ageVerification\w*|AgeVerification\w*|dateOfBirth|birthDate|date_of_birth)\b/,
  /["'][^"'\n]*\b(1[3678]\+|18 or older|over 18|at least 1[3678]|years old or older|confirm (your age|you are))[^"'\n]*["']/i,
];

// ---------------------------------------------------------------- AI data disclosure

/** "AI" is matched case-sensitively elsewhere so "said", "mail" or Italian "ai" never count. */
export const AI_ACRONYM = /\bAI\b/;
/** Names an AI service or a third party in prose. */
export const AI_PARTY = /artificial intelligence|\b(OpenAI|ChatGPT|GPT-?\d|Anthropic|Claude|Gemini|Vertex AI|Replicate|fal\.ai|Stability AI|Together AI|OpenRouter|Groq|xAI|Grok|Black Forest Labs|Hugging ?Face|Runway|Leonardo|ElevenLabs)\b|\bthird[- ]part(y|ies)\b|\bservice providers?\b/i;
export const SHARE_VERB = /\b(shar\w*|sen[dt]|sending|process\w*|upload\w*|transmit\w*|disclos\w*|consent\w*|agree\w*|allow\w*|permission)\b/i;
/**
 * "Analysis" discloses sharing only with a named provider or third party ("analyzed by OpenAI");
 * "Deep AI analysis of your week" is paywall marketing that says nothing about where data goes.
 */
export const ANALYZE_VERB = /\banaly[sz]\w*/i;
/** Paywall and plan screens: their AI copy sells a feature, it does not ask for consent. */
export const MARKETING_PATH = /paywall|subscri|premium|upgrade|pricing|\biap\b|(^|\/)(pro|plus|plans?)(view|screen|sheet|page)?\.\w+$/i;
export const CONSENT_WORD = /(consent|agree|accept|disclos|acknowledg|optin|opt_in|permission)/i;
export const AI_TOKENS = new Set(["ai", "llm", "openai", "gemini", "gpt", "chatgpt", "claude", "anthropic", "genai", "thirdparty"]);
