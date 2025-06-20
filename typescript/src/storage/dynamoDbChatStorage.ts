import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  GetCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteItemOutput,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { ChatStorage } from "./chatStorage";
import {
  ConversationMessage,
  ParticipantRole,
  TimestampedMessage,
} from "../types";
import { Logger } from "../utils/logger";
import { SummaryUtils } from "../utils/summaryUtils";

export class DynamoDbChatStorage extends ChatStorage {
  private tableName: string;
  private summaryTable: string;
  private docClient: DynamoDBDocumentClient;
  private ttlKey: string | null = null;
  private ttlDuration: number = 3600;
  private isAgentHistory: boolean = false;
  private maxHistoryCount: number;
  private maxFieldSize: number;

  constructor(
    tableName: string,
    summaryTable: string,
    region: string,
    ttlKey?: string,
    ttlDuration?: number,
    isAgentHistory?: boolean,
    maxHistoryCount?: number
  ) {
    super();
    this.tableName = tableName;
    this.ttlKey = ttlKey || null;
    this.ttlDuration = Number(ttlDuration) || 3600;
    const client = new DynamoDBClient({ region });
    this.docClient = DynamoDBDocumentClient.from(client);
    this.isAgentHistory = isAgentHistory;
    this.maxHistoryCount = maxHistoryCount || 10;
    this.maxFieldSize = 3500; //less than the 4kb limit for dynamodb
    this.summaryTable = summaryTable;
  }

  async saveChatMessage(
    userId: string,
    sessionId: string,
    agentId: string,
    newMessage: ConversationMessage,
    maxHistorySize?: number
  ): Promise<ConversationMessage[]> {
    const key = this.generateKey(userId, sessionId, agentId);
    // Fetch existing conversation
    const existingConversation = await this.fetchChat(
      userId,
      sessionId,
      agentId
    );

    if (super.isConsecutiveMessage(existingConversation, newMessage)) {
      Logger.logger.log(
        `> Consecutive ${newMessage.role} message detected for agent ${agentId}. Not saving.`
      );
      return existingConversation;
    }

    // Add new message with timestamp
    const updatedConversation: TimestampedMessage[] = [
      ...existingConversation.map((msg) => ({ ...msg, timestamp: Date.now() })),
      { ...newMessage, timestamp: Date.now() },
    ];

    // Apply maxHistorySize limit if specified
    const trimmedConversation = super.trimConversation(
      updatedConversation,
      maxHistorySize
    );

    // Prepare item for DynamoDB
    const item: Record<string, any> = {
      PK: userId,
      SK: key,
      conversation: trimmedConversation,
    };

    if (this.ttlKey) {
      item[this.ttlKey] = Math.floor(Date.now() / 1000) + this.ttlDuration;
    }

    // Save to DynamoDB
    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
        })
      );
    } catch (error) {
      Logger.logger.error("Error saving conversation to DynamoDB:", error);
      throw error;
    }

    // Return the updated conversation without timestamps
    return trimmedConversation;
  }

  async fetchChat(
    userId: string,
    sessionId: string,
    agentId: string
  ): Promise<ConversationMessage[]> {
    const key = this.generateKey(userId, sessionId, agentId);
    try {
      const response = await this.docClient.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { PK: userId, SK: key },
        })
      );
      const storedMessages: TimestampedMessage[] =
        response.Item?.conversation || [];

      return this.removeTimestamps(storedMessages);
    } catch (error) {
      Logger.logger.error("Error getting conversation from DynamoDB:", error);
      throw error;
    }
  }

  // Get summary for a conversation with chunk reconstruction
  async fetchSummary(userId: string, sessionId: string): Promise<string | null> {
    try {
      Logger.logger.info(`Fetching summary for ${userId} ${sessionId}`)
      const result = await this.docClient.send(
        new GetCommand({
          TableName: this.summaryTable,
          Key: { PK: userId, SK: sessionId },
        })
      );

      if (!result.Item) {
        Logger.logger.info("No summary found");
        return null;
      }

      const summary = result.Item;

      // If it's not chunked, return as-is
      if (!summary.isChunked) {
        return summary.conversation;
      }

      // If it's chunked, reconstruct from chunks
      if (summary.chunkCount) {
        Logger.logger.info(`Fetching summary for ${summary.chunkCount} chunks`);
        const chunkPromises: Promise<GetCommandOutput>[] = [];
        for (let i = 0; i < summary.chunkCount; i++) {
          const chunkParams = {
            TableName: this.summaryTable,
            Key: { PK: userId, SK: `${sessionId}#chunk_${i}` },
          };

          chunkPromises.push(this.docClient.send(new GetCommand(chunkParams)));
        }

        const chunkResults = await Promise.all(chunkPromises);
        const chunks = chunkResults
          .filter((result) => result.Item)
          .map((result) => result.Item)
          .sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0))
          .map((item) => item.conversation);
        Logger.logger.info(`Retrieved summary for all chunks`);
        return chunks.join("");
      }

      return summary.conversation || null;

    } catch (error) {
      Logger.logger.error("Error getting summary:", error);
      throw error;
    }
  }

  async fetchAllChats(
    userId: string,
    sessionId: string
  ): Promise<ConversationMessage[]> {
    try {
      let queryCommand;
      if (this.isAgentHistory) {
        queryCommand = {
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk and begins_with(SK, :skPrefix)",
          ExpressionAttributeValues: {
            ":pk": userId,
            ":skPrefix": `${sessionId}#`,
          },
        };
      } else {
        queryCommand = {
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk and SK = :sk",
          ExpressionAttributeValues: {
            ":pk": userId,
            ":sk": sessionId,
          },
        };
      }
      const response = await this.docClient.send(
        new QueryCommand(queryCommand)
      );

      if (!response.Items || response.Items.length === 0) {
        return [];
      }

      const allChats = response.Items.flatMap((item) => {
        if (!Array.isArray(item.conversation)) {
          Logger.logger.error("Unexpected item structure:", item);
          return [];
        }

        // Extract agentId from the SK
        const agentId = item.SK.split("#")[1];
        const agentName = agentId ? `[${agentId}] ` : "";

        return item.conversation.map(
          (msg) =>
            ({
              role: msg.role,
              content:
                msg.role === ParticipantRole.ASSISTANT
                  ? [
                      {
                        text: `${agentName}${Array.isArray(msg.content) ? msg.content[0]?.text || "" : msg.content || ""}`,
                      },
                    ]
                  : Array.isArray(msg.content)
                    ? msg.content.map((content) => ({ text: content.text }))
                    : [{ text: msg.content || "" }],
              timestamp: Number(msg.timestamp),
            }) as TimestampedMessage
        );
      });

      allChats.sort((a, b) => a.timestamp - b.timestamp);
      return this.removeTimestamps(allChats);
    } catch (error) {
      Logger.logger.error("Error querying conversations from DynamoDB:", error);
      throw error;
    }
  }

  private generateKey(
    userId: string,
    sessionId: string,
    agentId: string
  ): string {
    if (this.isAgentHistory) {
      return `${sessionId}#${agentId}`;
    } else {
      return `${sessionId}`;
    }
  }

  private removeTimestamps(
    messages: TimestampedMessage[] | ConversationMessage[]
  ): ConversationMessage[] {
    return messages.map((msg) => {
      const { timestamp: _timestamp, ...rest } = msg as TimestampedMessage;
      return rest;
    });
  }

  // Summarize conversation and truncate old messages
  async summarizeAndTruncate(
    userId: string,
    sessionId: string,
    summaryUtils: SummaryUtils
  ): Promise<void> {
    try {
      Logger.logger.info(`Starting summarization for  ${userId} : ${sessionId}`);

      // Get all chats
      const allChats = await this.fetchAllChats(userId, sessionId);
      Logger.logger.info(`There is ${allChats.length} and max chat size is set to ${this.maxHistoryCount}`)
      if (allChats.length <= this.maxHistoryCount) {
        Logger.logger.info(
          `Number of message ${allChats.length} is less than max history count ${this.maxHistoryCount}. Not summarizing.`
        );
        return; // No need to summarize
      }

      // Chats to summarize (all except the most recent ones to keep)
      const chatsToSummarize = allChats.slice(
        0,
        allChats.length - this.maxHistoryCount
      );

      const remainingChats = allChats.slice(
        allChats.length - this.maxHistoryCount
      );

      Logger.logger.info(`Generating summary for ${chatsToSummarize.length} and history for ${remainingChats.length} chats`)

      // Generate summary
      const summary = await summaryUtils.generateSummary(chatsToSummarize);
      Logger.logger.info(`Summary generated :  ${summary}`);

      // Save or update summary
      await this.saveSummary(userId, sessionId, summary, summaryUtils);

      // update history messages with new slice
      await this.updateMessages(userId, sessionId, remainingChats);

      Logger.logger.info(`Summarization completed for ${userId}: ${sessionId}`);
    } catch (error) {
      Logger.logger.error("Error during summarization:", error);
      throw error;
    }
  }

  // Save summary to DynamoDB with chunking support
  private async saveSummary(
    userId: string,
    sessionId: string,
    newContent: string,
    summaryUtils: SummaryUtils
  ): Promise<void> {
    try {

      //Get existing summary and combine with new
      const existingSummary = await this.fetchSummary(userId, sessionId);
      const summaryContent = existingSummary+"."+newContent;

      // Check if summary exceeds size limit
      if (Buffer.byteLength(summaryContent, "utf8") > this.maxFieldSize) {
        Logger.logger.info(`Summary exceeds size limit, chunking...`);
        await this.saveLargeSummary(
          userId,
          sessionId,
          summaryContent,
          summaryUtils
        );
      } else {
        // Normal summary save
        const item = {
          PK: userId,
          SK: sessionId,
          conversation: summaryContent,
          isChunked: false,
          chunkCount: 0,
        };
        if (this.ttlKey) {
          item[this.ttlKey] = Math.floor(Date.now() / 1000) + this.ttlDuration;
        }
        await this.docClient.send(
          new PutCommand({
            TableName: this.summaryTable,
            Item: item,
          })
        );
        Logger.logger.info(`Summary saved to table ${this.summaryTable}`, item);
      }
    } catch (error) {
      Logger.logger.error("Error saving summary:", error);
      throw error;
    }
  }

  // Save large summary as chunks
  private async saveLargeSummary(
    userId: string,
    sessionId: string,
    summaryContent: string,
    summaryUtils: SummaryUtils
  ): Promise<void> {
    const chunks = summaryUtils.splitContent(summaryContent);

    // Delete existing summary chunks first
    await this.deleteExistingSummary(userId, sessionId);
    Logger.logger.info(`Existing summary deleted`);

    // Save each chunk
    const chunkPromises = chunks.map((chunk, index) => {
      const item = {
        PK: userId,
        SK: `${sessionId}#chunk_${index}`,
        conversation: chunk,
        isChunked: true,
        chunkCount: chunks.length,
      };
      if (this.ttlKey) {
        item[this.ttlKey] = Math.floor(Date.now() / 1000) + this.ttlDuration;
      }
      return this.docClient.send(
        new PutCommand({
          TableName: this.summaryTable,
          Item: item,
        })
      );
    });

    await Promise.all(chunkPromises);
    Logger.logger.info(`Saved ${chunks.length} chunks for summary`);

    // Save metadata record
    const metaItem = {
      PK: userId,
      SK: sessionId,
      conversation: "",
      isChunked: true,
      chunkCount: chunks.length,
    };
    if (this.ttlKey) {
      metaItem[this.ttlKey] = Math.floor(Date.now() / 1000) + this.ttlDuration;
    }
    await this.docClient.send(
      new PutCommand({
        TableName: this.summaryTable,
        Item: metaItem,
      })
    );

    Logger.logger.info(`Saved chunks metadata`);
  }

  // Delete existing summary (including chunks)
  private async deleteExistingSummary(
    userId: string,
    sessionId: string
  ): Promise<void> {
    try {
      //delete  main summary
      const command = new DeleteCommand({
        TableName: this.summaryTable,
        Key:  {
          PK: userId,
          SK: sessionId,
        },
        ReturnValues: "ALL_OLD"
      });
      const existingSummary = await this.docClient.send(command);
      const oldItem = existingSummary.Attributes;
      // If it was chunked, delete all chunks
      if (oldItem.isChunked && oldItem.totalChunks) {
        const deletePromises: Promise<DeleteItemOutput>[] = [];
        for (let i = 0; i < oldItem.totalChunks; i++) {
          deletePromises.push(
            this.docClient.send(
              new DeleteCommand({
                TableName: this.summaryTable,
                Key: {
                  PK: userId,
                  SK: `${sessionId}#chunk_${i}`,
                },
              })
            )
          );
        }
        await Promise.all(deletePromises);
      }
    } catch (error) {
      Logger.logger.error("Error deleting existing summary:", error);
    }
  }

  // update old messages with new history slice
  private async updateMessages(
    userId: string,
    sessionId: string,
    messages: ConversationMessage[]
  ): Promise<void> {
    // Prepare item for DynamoDB
    const item: Record<string, any> = {
      PK: userId,
      SK: sessionId,
      conversation: messages,
    };

    if (this.ttlKey) {
      item[this.ttlKey] = Math.floor(Date.now() / 1000) + this.ttlDuration;
    }

    //upsert
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      })
    );

    Logger.logger.info(`Chat history updated after summarization`);
  }
}
