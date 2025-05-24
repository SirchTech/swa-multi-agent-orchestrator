// Define minimal types for Transform to avoid dependency on 'stream' module
interface TransformOptions {
  objectMode?: boolean;
  highWaterMark?: number;
}

type TransformCallback = (error?: Error | null, data?: any) => void;

// Minimal implementation of Transform class
class BaseTransform {
  constructor(options?: TransformOptions) {}
  
  protected _transform(chunk: any, encoding: string, callback: TransformCallback): void {
    callback(null, chunk);
  }
  
  protected _flush(callback: TransformCallback): void {
    callback();
  }
  
  public push(chunk: any): boolean {
    // This is a simplified implementation - in the real Transform class, 
    // this would write to the output stream
    return true;
  }
  
  public end(): void {
    // In the real Transform, this would end the stream
  }
  
  public destroy(error?: Error): void {
    // In the real Transform, this would destroy the stream
  }
}

import { ConversationMessage, ToolInput } from '../types';


export class AccumulatorTransform extends BaseTransform {
    private accumulator: string;
    // Using an array to accumulate chunks is more efficient than string concatenation
    private accumulatorChunks: string[];
    private accumulatorSize: number;
    // Maximum size before forcing a string join to prevent excessive memory usage
    private readonly MAX_ACCUMULATOR_SIZE = 1000; 

    constructor() {
      super({
        objectMode: true,  // This allows the transform to handle object chunks
        highWaterMark: 64  // Increase internal buffer size for better performance
      });
      this.accumulator = '';
      this.accumulatorChunks = [];
      this.accumulatorSize = 0;
    }

    _transform(chunk: any, encoding: string, callback: TransformCallback): void {
      try {
        const text = this.extractTextFromChunk(chunk);
        if (text) {
          // Add chunk to array instead of concatenating strings
          this.accumulatorChunks.push(text);
          this.accumulatorSize++;
          
          // If we've accumulated many chunks, join them to prevent memory issues
          if (this.accumulatorSize >= this.MAX_ACCUMULATOR_SIZE) {
            this.accumulator += this.accumulatorChunks.join('');
            this.accumulatorChunks = [];
            this.accumulatorSize = 0;
          }
          
          this.push(text);  // Push the text to output stream
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Optimize text extraction with more efficient conditions
    extractTextFromChunk(chunk: any): string | null {
      if (typeof chunk === 'string') {
        return chunk;
      } 
      
      // Check for nested properties more safely
      if (chunk?.contentBlockDelta?.delta?.text) {
        return chunk.contentBlockDelta.delta.text;
      }
      
      // Additional format support for various LLM APIs
      if (chunk?.choices?.[0]?.delta?.content) {
        return chunk.choices[0].delta.content;
      }
      
      if (chunk?.delta?.text) {
        return chunk.delta.text;
      }
      
      if (chunk?.content) {
        return typeof chunk.content === 'string' ? chunk.content : null;
      }
      
      return null;
    }

    _flush(callback: TransformCallback): void {
      // Make sure to join any remaining chunks when stream ends
      if (this.accumulatorSize > 0) {
        this.accumulator += this.accumulatorChunks.join('');
        this.accumulatorChunks = [];
        this.accumulatorSize = 0;
      }
      callback();
    }

    getAccumulatedData(): string {
      // Join any remaining chunks with the accumulator
      if (this.accumulatorSize > 0) {
        this.accumulator += this.accumulatorChunks.join('');
        this.accumulatorChunks = [];
        this.accumulatorSize = 0;
      }
      return this.accumulator;
    }
  }

  export function extractXML(text: string) {
    const xmlRegex = /<response>[\s\S]*?<\/response>/;
    const match = text.match(xmlRegex);
    return match ? match[0] : null;
  }


  export function isClassifierToolInput(input: unknown): input is ToolInput {
    return (
      typeof input === 'object' &&
      input !== null &&
      'userinput' in input &&
      'selected_agent' in input &&
      'confidence' in input
    );
  }

  export function isConversationMessage(result: any): result is ConversationMessage {
    return (
      result &&
      typeof result === "object" &&
      "role" in result &&
      "content" in result &&
      Array.isArray(result.content)
    );
  }


