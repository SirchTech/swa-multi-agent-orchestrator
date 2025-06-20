import { ConversationMessage } from "../types";
import { SummaryUtils } from "../utils/summaryUtils";

export abstract class ChatStorage {

  public isConsecutiveMessage(conversation: ConversationMessage[], newMessage: ConversationMessage): boolean {
    if (conversation.length === 0) return false;
    const lastMessage = conversation[conversation.length - 1];
    return lastMessage.role === newMessage.role;
  }

  protected trimConversation(conversation: ConversationMessage[], maxHistorySize?: number): ConversationMessage[] {
    if (maxHistorySize === undefined) return conversation;
    
    // Ensure maxHistorySize is even to maintain complete binoms
    const adjustedMaxHistorySize = maxHistorySize % 2 === 0 ? maxHistorySize : maxHistorySize - 1;
    
    return conversation.slice(-adjustedMaxHistorySize);
  }

  public async fetchSummary(userId: string, sessionId: string): Promise<string | null> {
    return `Override Summary implement for ${userId}${sessionId}`
  }

  public async summarizeAndTruncate(
      userId: string,
      sessionId: string,
      summaryUtils: SummaryUtils
    ): Promise<void> {
      console.log(`Over rider for summary and truncate : ${userId}${sessionId} ${summaryUtils}`)
    }

  abstract saveChatMessage(
    userId: string,
    sessionId: string,
    agentId: string,
    newMessage: ConversationMessage,
    maxHistorySize?: number
  ): Promise<ConversationMessage[]>;

  abstract fetchChat(
    userId: string,
    sessionId: string,
    agentId: string,
    maxHistorySize?: number
  ): Promise<ConversationMessage[]>;

  abstract fetchAllChats(
    userId: string,
    sessionId: string
  ): Promise<ConversationMessage[]>;
}