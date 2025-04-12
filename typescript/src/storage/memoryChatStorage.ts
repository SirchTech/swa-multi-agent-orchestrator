import { ChatStorage } from "./chatStorage";
import { ConversationMessage, ParticipantRole, TimestampedMessage } from "../types";
import { Logger } from "../utils/logger";

export class InMemoryChatStorage extends ChatStorage {
  private conversations: Map<string, TimestampedMessage[]>;

  constructor() {
    super();
    this.conversations = new Map();
  }

  async saveChatMessage(
    userId: string,
    sessionId: string,
    agentId: string,
    newMessage: ConversationMessage,
    maxHistorySize?: number
  ): Promise<ConversationMessage[]> {
    const key = this.generateKey(userId, sessionId, agentId);
    let conversation = this.conversations.get(key) || [];

    if (super.isConsecutiveMessage(conversation, newMessage)) {
      Logger.logger.log(`> Consecutive ${newMessage.role} message detected for agent ${agentId}. Not saving.`);
      return this.removeTimestamps(conversation);
    }

    const timestampedMessage: TimestampedMessage = { ...newMessage, timestamp: Date.now() };
    
    // Avoid creating a new array with spread, just push the item for better performance
    conversation.push(timestampedMessage);
    conversation = super.trimConversation(conversation, maxHistorySize) as TimestampedMessage[];

    this.conversations.set(key, conversation);
    
    // Invalidate the chat history cache for this user session
    // This ensures fetchAllChats will rebuild its cache with the new message
    const cacheKey = `${userId}#${sessionId}`;
    this.chatHistoryCache.delete(cacheKey);
    
    return this.removeTimestamps(conversation);
  }

  async fetchChat(
    userId: string,
    sessionId: string,
    agentId: string,
    maxHistorySize?: number
  ): Promise<ConversationMessage[]> {
    const key = this.generateKey(userId, sessionId, agentId);
    let conversation = this.conversations.get(key) || [];
    if (maxHistorySize !== undefined) {
      conversation = super.trimConversation(conversation, maxHistorySize) as TimestampedMessage[];
    }
    return this.removeTimestamps(conversation);
  }

  // Cache key for conversation history to avoid expensive operations on repeated calls
  private chatHistoryCache = new Map<string, { 
    messages: ConversationMessage[]; 
    timestamp: number;
    messagesCount: number;
  }>();
  
  // TTL for chat history cache (5 seconds)
  private readonly HISTORY_CACHE_TTL = 5000;
  
  async fetchAllChats(
    userId: string,
    sessionId: string
  ): Promise<ConversationMessage[]> {
    const cacheKey = `${userId}#${sessionId}`;
    const now = Date.now();
    
    // Check if we have a cached conversation history that's still valid
    const cachedHistory = this.chatHistoryCache.get(cacheKey);
    
    // If we have a valid cache and the message count hasn't changed, return the cached data
    let totalMessagesCount = 0;
    for (const [key, messages] of this.conversations.entries()) {
      const [storedUserId, storedSessionId] = key.split('#');
      if (storedUserId === userId && storedSessionId === sessionId) {
        totalMessagesCount += messages.length;
      }
    }
    
    if (cachedHistory && 
        (now - cachedHistory.timestamp) < this.HISTORY_CACHE_TTL && 
        cachedHistory.messagesCount === totalMessagesCount) {
      return cachedHistory.messages;
    }
    
    // If not, rebuild the history
    const allMessages: TimestampedMessage[] = [];
    for (const [key, messages] of this.conversations.entries()) {
      const [storedUserId, storedSessionId, agentId] = key.split('#');
      if (storedUserId === userId && storedSessionId === sessionId) {
        // Optimize by reducing object creation and property copying
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          if (message.role === ParticipantRole.ASSISTANT) {
            // Only create new objects for assistant messages that need modification
            allMessages.push({
              ...message,
              content: [{ text: `[${agentId}] ${message.content?.[0]?.text || ''}` }]
            });
          } else {
            // For user messages, just add the reference without creating a new object
            allMessages.push(message);
          }
        }
      }
    }
    
    // Sort messages by timestamp
    allMessages.sort((a, b) => a.timestamp - b.timestamp);
    const result = this.removeTimestamps(allMessages);
    
    // Update the cache
    this.chatHistoryCache.set(cacheKey, {
      messages: result,
      timestamp: now,
      messagesCount: totalMessagesCount
    });
    
    return result;
  }

  private generateKey(userId: string, sessionId: string, agentId: string): string {
    return `${userId}#${sessionId}#${agentId}`;
  }

  private removeTimestamps(messages: TimestampedMessage[]): ConversationMessage[] {
    return messages.map(({ timestamp: _timestamp, ...message }) => message);
  }
}