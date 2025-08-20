import { ChatStorage } from '../storage/chatStorage';
import { ConversationMessage, ParticipantRole } from '../types';


export async function saveConversationExchange(
  userInput: string,
  agentResponse: string,
  storage: ChatStorage,
  userId: string,
  sessionId: string,
  agentId: string,
  maxHistorySize?: number
) {
  const stats = [];

  const userInputObj: ConversationMessage = {
    role: ParticipantRole.USER,
    content: [{ text: userInput }],
  };

  await storage.saveChatMessage(
    userId,
    sessionId,
    agentId,
    userInputObj,
    maxHistorySize
  );

  stats.push(...(userInputObj.modelStats ?? []));

  const agentResponseObj: ConversationMessage = {
    role: ParticipantRole.ASSISTANT,
    content: [{ text: agentResponse }],
  };

  await storage.saveChatMessage(
    userId,
    sessionId,
    agentId,
    agentResponseObj,
    maxHistorySize
  );

  stats.push(...(agentResponseObj.modelStats ?? []));
  return stats;
}