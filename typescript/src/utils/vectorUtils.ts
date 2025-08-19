import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export class VectorUtils {
  private bedrockClient: BedrockRuntimeClient;
  private maxTokens: number;
  private overlap: number;

  constructor() {
    this.bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.maxTokens = 7000;
    this.overlap = 200;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const command = new InvokeModelCommand({
        modelId: "amazon.titan-embed-text-v2:0",
        body: JSON.stringify({
          inputText: text,
        }),
        contentType: "application/json",
        accept: "application/json",
      });
      
      const response = await this.bedrockClient.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      return responseBody.embedding;
    } catch (error) {
      console.error("Error generating embedding:", error);
      throw error;
    }
  }

  chunkText(input: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while(start < input.length) {
      const end = Math.min(start + this.maxTokens, input.length);
      const slice = input.slice(start, end).trim();
      if (slice.length > 0) chunks.push(slice);
      if (end === input.length) break;
      start = end - this.overlap; // overlap for context
    }
    return chunks;
  }
}
