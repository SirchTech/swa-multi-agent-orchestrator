import {
  ANTHROPIC_MODEL_ID_CLAUDE_3_5_SONNET,
  ConversationMessage,
  ParticipantRole,
} from "../types";
import { isClassifierToolInput } from "../utils/helpers";
import { Logger } from "../utils/logger";
import { Classifier, ClassifierResult } from "./classifier";
import { fetchDescription } from "../utils/s3Utils";

// Define minimal Anthropic types to avoid dependency on @anthropic-ai/sdk
// This allows the code to compile without the actual SDK
interface AnthropicTypes {
  Tool: any;
  TextBlock: { type: string; text: string };
  ToolUseBlock: { type: string; id: string; name: string; input: any };
  MessageParam: { role: string; content: string | any[] };
  Message: {
    id: string;
    model: string;
    usage: any;
    content: any[];
    stop_reason?: string;
  };
}

// Create a minimal implementation of the Anthropic client
class Anthropic {
  constructor(options: { apiKey: string }) {}
  
  messages = {
    create: async (params: any): Promise<any> => {
      // This is just a placeholder that would be replaced by the actual SDK implementation
      throw new Error("Anthropic SDK not installed. Please install @anthropic-ai/sdk package.");
    }
  };
}

// Create namespace to match SDK structure
namespace Anthropic {
  export type Tool = AnthropicTypes['Tool'];
  export type TextBlock = AnthropicTypes['TextBlock'];
  export type ToolUseBlock = AnthropicTypes['ToolUseBlock'];
  export type MessageParam = AnthropicTypes['MessageParam'];
  export type Message = AnthropicTypes['Message']; 
}

export interface AnthropicClassifierOptions {
  // Optional: The ID of the Anthropic model to use for classification
  // If not provided, a default model may be used
  modelId?: string;

  logRequest?: boolean;

  // Optional: Configuration for the inference process
  inferenceConfig?: {
    // Maximum number of tokens to generate in the response
    maxTokens?: number;

    // Controls randomness in output generation
    // Higher values (e.g., 0.8) make output more random, lower values (e.g., 0.2) make it more deterministic
    temperature?: number;

    // Controls diversity of output via nucleus sampling
    // 1.0 considers all tokens, lower values (e.g., 0.9) consider only the most probable tokens
    topP?: number;

    // Array of sequences that will stop the model from generating further tokens when encountered
    stopSequences?: string[];
  };

  // The API key for authenticating with Anthropic's services
  apiKey: string;
}

export class AnthropicClassifier extends Classifier {
  private client: Anthropic;
  protected inferenceConfig: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };

  private tools: Anthropic.Tool[] = [
    {
      name: "analyzePrompt",
      description: "Analyze the user input and provide structured output",
      input_schema: {
        type: "object",
        properties: {
          userinput: {
            type: "string",
            description: "The original user input",
          },
          selected_agent: {
            type: "string",
            description: "The name of the selected agent",
          },
          confidence: {
            type: "number",
            description: "Confidence level between 0 and 1",
          },
        },
        required: ["userinput", "selected_agent", "confidence"],
      },
    },
  ];

  constructor(options: AnthropicClassifierOptions) {
    super();

    if (!options.apiKey) {
      throw new Error("Anthropic API key is required");
    }
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.logRequest = options.logRequest ?? false;
    this.modelId = options.modelId || ANTHROPIC_MODEL_ID_CLAUDE_3_5_SONNET;
    // Set default value for max_tokens if not provided
    const defaultMaxTokens = 4096; // You can adjust this default value as needed
    this.inferenceConfig = {
      maxTokens: options.inferenceConfig?.maxTokens ?? defaultMaxTokens,
      temperature: options.inferenceConfig?.temperature,
      topP: options.inferenceConfig?.topP,
      stopSequences: options.inferenceConfig?.stopSequences,
    };
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  // Simple request caching to avoid redundant classification
  private cache = new Map<string, {
    result: ClassifierResult;
    timestamp: number;
  }>();
  private readonly CACHE_TTL = 30 * 1000; // 30 seconds cache TTL

  // Create a hash for the input to use as cache key
  private createCacheKey(input: string): string {
    // Use a simple hash function for the input string
    const hashInput = input.trim().toLowerCase();
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      const char = hashInput.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  async processRequest(
    inputText: string,
    chatHistory: ConversationMessage[]
  ): Promise<ClassifierResult> {
    // Check if we have a recent cached result for this input
    const cacheKey = this.createCacheKey(inputText);
    const now = Date.now();
    const cachedItem = this.cache.get(cacheKey);
    
    if (cachedItem && (now - cachedItem.timestamp) < this.CACHE_TTL) {
      Logger.logger.debug(`Using cached classification result for input: ${inputText.substring(0, 30)}...`);
      return cachedItem.result;
    }

    const userMessage: Anthropic.MessageParam = {
      role: ParticipantRole.USER,
      content: inputText,
    };

    let retry = true;
    let executionCount = 0;
    while (retry) {
      retry = false;
      executionCount = executionCount + 1;
      try {
        const req = {
          model: this.modelId,
          max_tokens: this.inferenceConfig.maxTokens,
          messages: [userMessage],
          system: this.systemPrompt,
          temperature: this.inferenceConfig.temperature,
          top_p: this.inferenceConfig.topP,
          tools: this.tools,
        };
        const response = await this.client.messages.create(req);

        if (this.logRequest) {
          console.log("\n\n---- Anthropic Classifier ----");
          console.log(JSON.stringify(req));
          console.log(JSON.stringify(response));
          console.log("\n\n");
        }

        const modelStats = [];
        const obj = {};
        obj["id"] = response.id;
        obj["model"] = response.model;
        obj["usage"] = response.usage;
        obj["from"] = "anthropic_classifier";
        modelStats.push(obj);
        Logger.logger.info(`Anthropic Classifier Usage: `, JSON.stringify(obj));
        const toolUse = response.content.find(
          (content): content is Anthropic.ToolUseBlock =>
            content.type === "tool_use"
        );

        if (!toolUse) {
          throw new Error(
            "Classifier Error: No tool use found in the response"
          );
        }

        if (!isClassifierToolInput(toolUse.input)) {
          throw new Error(
            "Classifier Error: Tool input does not match expected structure"
          );
        }

        const selectedAgent = this.getAgentById(toolUse.input.selected_agent);
        
        // Start fetching S3 description in parallel if needed
        let descriptionPromise: Promise<string> | null = null;
        if (
          selectedAgent &&
          selectedAgent.s3details &&
          selectedAgent.s3details.indexOf("##") > 0
        ) {
          Logger.logger.info(
            `For selected agent fetching info from s3: ${selectedAgent.s3details}`
          );
          const s3details = selectedAgent.s3details;
          const [S3Bucket, fileId] = s3details.split("##");
          descriptionPromise = fetchDescription(S3Bucket, fileId);
        }

        // Create the result object
        const intentClassifierResult: ClassifierResult = {
          selectedAgent: selectedAgent,
          confidence: parseFloat(toolUse.input.confidence),
          modelStats: modelStats,
        };

        // If we need to update the description, await the promise now
        if (descriptionPromise && selectedAgent) {
          try {
            const description = await descriptionPromise;
            selectedAgent.description = description;
          } catch (err) {
            Logger.logger.error("Error fetching agent description from S3:", err);
            // Continue with existing description if S3 fetch fails
          }
        }

        // Cache the result
        this.cache.set(cacheKey, {
          result: intentClassifierResult,
          timestamp: now
        });

        return intentClassifierResult;
      } catch (error) {
        Logger.logger.error(
          "Anthropic Classifier Error: Error classifying request:",
          error
        );

        // More sophisticated retry logic with exponential backoff
        const isRateLimited = error.error?.type === "overloaded_error" || 
                             error.error?.type === "rate_limit_error" ||
                             error.status === 429;
        
        const isServerError = error.status >= 500 && error.status < 600;
        
        // Retry for rate limiting or server errors
        if ((isRateLimited || isServerError) && executionCount < 5) {
          retry = true;
          
          // Exponential backoff with jitter to avoid thundering herd problem
          // Base delay: 300ms, maximum delay: 10 seconds
          const baseDelay = 300;
          const maxDelay = 10000;
          const exponentialDelay = Math.min(
            maxDelay,
            baseDelay * Math.pow(2, executionCount - 1)
          );
          
          // Add jitter (±25% of the delay)
          const jitter = 0.5 - Math.random();
          const delay = exponentialDelay + (exponentialDelay * jitter * 0.25);
          
          Logger.logger.info(
            `Anthropic Classifier Error: ${error.error?.type || error.status}. Retry: ${executionCount}, delay: ${Math.round(delay)}ms`
          );
          
          await new Promise(resolve => setTimeout(resolve, delay));
        } else if (isRateLimited) {
          Logger.logger.info(
            `Anthropic Classifier Error: Exceeded retry count for rate limit error`
          );
          throw error;
        } else {
          // Instead of returning a default result, throw the error for non-retryable errors
          throw error;
        }
      }
    }
    throw new Error("Anthropic Classifier Error: Please try again.");
  }
}

function delay(t: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, t);
  });
}
