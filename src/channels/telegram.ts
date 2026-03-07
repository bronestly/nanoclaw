import fs from 'fs';
import path from 'path';

import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  abortVaultIndex,
  buildVaultIndex,
  getIndexStatus,
} from '../vault-indexer.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Parse a Telegram JID into chat ID and optional topic thread ID.
 * Format: "tg:{chatId}" or "tg:{chatId}:{threadId}"
 */
function parseTgJid(jid: string): { chatId: string; threadId?: number } {
  const withoutPrefix = jid.replace(/^tg:/, '');
  const lastColon = withoutPrefix.lastIndexOf(':');
  // A negative chatId like -1003343099881 contains a colon after the prefix removal?
  // No — the chatId itself uses a minus sign, not colons. Safe to split on last colon.
  if (lastColon > 0) {
    const possibleThread = withoutPrefix.slice(lastColon + 1);
    const threadId = parseInt(possibleThread, 10);
    if (!isNaN(threadId)) {
      return { chatId: withoutPrefix.slice(0, lastColon), threadId };
    }
  }
  return { chatId: withoutPrefix };
}

/**
 * Build a Telegram JID, including topic thread if present.
 */
function buildTgJid(chatId: number | string, threadId?: number): string {
  return threadId != null ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  clearSession?: (jid: string) => boolean;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a file from Telegram and save it to destDir/fileName.
   * Returns the container-side path (/workspace/group/attachments/...) on success,
   * or null if the file is too large, unavailable, or download fails.
   */
  private async downloadAttachment(
    fileId: string,
    destDir: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      const fileInfo = await this.bot!.api.getFile(fileId);
      if (!fileInfo.file_path) {
        logger.warn({ fileId }, 'Telegram file has no file_path (too large?)');
        return null;
      }
      const url = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn(
          { fileId, status: response.status },
          'Telegram file download failed',
        );
        return null;
      }
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, fileName);
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(destPath, Buffer.from(buffer));
      logger.info(
        { destPath, bytes: buffer.byteLength },
        'Telegram attachment downloaded',
      );
      return `/workspace/group/attachments/${fileName}`;
    } catch (err) {
      logger.warn({ fileId, err }, 'Failed to download Telegram attachment');
      return null;
    }
  }

  /**
   * Extract a quoted-message prefix from reply_to_message.
   * Returns a string like `[Quoting SenderName: "...text..."]\n` or empty string.
   * The prefix is intentionally brief — the full prior message already lives in
   * the conversation history that Claude receives, so this is just a pointer.
   */
  private buildReplyPrefix(replyTo: any): string {
    if (!replyTo) return '';

    const senderName =
      replyTo.from?.first_name ||
      replyTo.from?.username ||
      replyTo.from?.id?.toString() ||
      'Someone';

    // Prefer text; fall back to caption (photos, docs, etc.); then a type label
    let quotedText: string;
    if (replyTo.text) {
      quotedText = replyTo.text;
    } else if (replyTo.caption) {
      quotedText = replyTo.caption;
    } else if (replyTo.photo) {
      quotedText = '[Photo]';
    } else if (replyTo.video) {
      quotedText = '[Video]';
    } else if (replyTo.voice) {
      quotedText = '[Voice message]';
    } else if (replyTo.audio) {
      quotedText = `[Audio: ${replyTo.audio.file_name || 'audio'}]`;
    } else if (replyTo.document) {
      quotedText = `[Document: ${replyTo.document.file_name || 'file'}]`;
    } else if (replyTo.sticker) {
      quotedText = `[Sticker ${replyTo.sticker.emoji || ''}]`;
    } else {
      quotedText = '[message]';
    }

    // Truncate long quotes so they don't bloat the prompt
    const MAX_QUOTE = 300;
    const truncated =
      quotedText.length > MAX_QUOTE
        ? quotedText.slice(0, MAX_QUOTE) + '…'
        : quotedText;

    return `[In reply to ${senderName}: "${truncated}"]\n`;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const baseJid = `tg:${chatId}`;
      const topicJid = threadId != null ? buildTgJid(chatId, threadId) : null;

      const lines = [
        `Chat ID: \`${baseJid}\``,
        topicJid ? `Topic ID: \`${topicJid}\`` : null,
        `Name: ${chatName}`,
        `Type: ${chatType}`,
      ]
        .filter(Boolean)
        .join('\n');

      ctx.reply(lines, { parse_mode: 'Markdown' });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // ── Admin commands (main group only) ───────────────────────────────────

    /** Returns true if the sender chat is the registered main group. */
    const isAdminChat = (
      chatId: number | string,
      threadId?: number,
    ): boolean => {
      const groups = this.opts.registeredGroups();
      const topicJid = threadId != null ? buildTgJid(chatId, threadId) : null;
      const baseJid = `tg:${chatId}`;
      const jid = topicJid && groups[topicJid] ? topicJid : baseJid;
      return groups[jid]?.isMain === true;
    };

    this.bot.command('index_status', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      const s = getIndexStatus();
      if (s.running) {
        ctx.reply(
          `Index: running\nFiles: ${s.filesDone}/${s.filesTotal}\nNew: ${s.indexed} | Cached: ${s.skipped}\nStarted: ${s.startedAt}`,
        );
      } else if (s.startedAt === null) {
        ctx.reply('Index: never run');
      } else {
        const state = s.aborted ? 'aborted' : 'idle';
        ctx.reply(
          `Index: ${state}\nFiles: ${s.filesDone}/${s.filesTotal}\nNew: ${s.indexed} | Cached: ${s.skipped}\nCompleted: ${s.completedAt}`,
        );
      }
    });

    this.bot.command('index_start', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      const s = getIndexStatus();
      if (s.running) {
        ctx.reply('Index is already running.');
        return;
      }
      ctx.reply('Starting incremental index...');
      buildVaultIndex(false).catch((err) =>
        logger.error({ err }, 'Vault index failed (triggered via Telegram)'),
      );
    });

    this.bot.command('index_rebuild', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      const s = getIndexStatus();
      if (s.running) {
        ctx.reply('Index is already running. Abort first with /index_abort.');
        return;
      }
      ctx.reply('Starting full index rebuild (this will take a while)...');
      buildVaultIndex(true).catch((err) =>
        logger.error(
          { err },
          'Vault index rebuild failed (triggered via Telegram)',
        ),
      );
    });

    this.bot.command('index_abort', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      const aborted = abortVaultIndex();
      ctx.reply(aborted ? 'Aborting index...' : 'No index run is active.');
    });

    this.bot.command('index_restart', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      const wasRunning = abortVaultIndex();
      if (wasRunning) {
        ctx.reply('Aborting current run, then restarting...');
        // Give the abort a moment to propagate before starting a new run
        setTimeout(() => {
          buildVaultIndex(false).catch((err) =>
            logger.error(
              { err },
              'Vault index restart failed (triggered via Telegram)',
            ),
          );
        }, 500);
      } else {
        ctx.reply('Starting index...');
        buildVaultIndex(false).catch((err) =>
          logger.error(
            { err },
            'Vault index restart failed (triggered via Telegram)',
          ),
        );
      }
    });

    // /clear_context — scoped to the topic where the command is sent
    this.bot.command('clear_context', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      const topicJid = buildTgJid(ctx.chat.id, threadId);
      const baseJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      // Resolve the JID for this specific topic (or base chat if no topic registered)
      const chatJid = groups[topicJid] ? topicJid : baseJid;
      if (!groups[chatJid]) {
        ctx.reply('This chat is not registered.');
        return;
      }
      const cleared = this.opts.clearSession?.(chatJid);
      ctx.reply(
        cleared
          ? 'Context cleared. The next message will start a fresh session.'
          : 'Nothing to clear.',
      );
    });

    this.bot.command('reload_commands', (ctx) => {
      const threadId = (ctx.message as any)?.message_thread_id as
        | number
        | undefined;
      if (!isAdminChat(ctx.chat.id, threadId)) return;
      this.registerBotCommands()
        .then(() => ctx.reply('Bot commands reloaded.'))
        .catch((err) => {
          logger.error({ err }, 'Failed to reload bot commands');
          ctx.reply('Failed to reload commands — check logs.');
        });
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const threadId = (ctx.message as any).message_thread_id as
        | number
        | undefined;
      const topicJid = buildTgJid(ctx.chat.id, threadId);
      const baseJid = `tg:${ctx.chat.id}`;

      const replyPrefix = this.buildReplyPrefix(
        (ctx.message as any).reply_to_message,
      );
      let content = replyPrefix + ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || baseJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Route: prefer topic-specific JID, fall back to base chat JID
      const groups = this.opts.registeredGroups();
      const chatJid = groups[topicJid] ? topicJid : baseJid;

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = groups[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download the file when possible, then store a message
    // with the container-side path so the agent can read it.
    const storeNonText = async (
      ctx: any,
      placeholder: string,
      fileId?: string,
      fileName?: string,
    ) => {
      const threadId = ctx.message?.message_thread_id as number | undefined;
      const topicJid = buildTgJid(ctx.chat.id, threadId);
      const baseJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const chatJid = groups[topicJid] ? topicJid : baseJid;
      const group = groups[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Attachment from unregistered Telegram chat');
        return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const replyPrefix = this.buildReplyPrefix(ctx.message.reply_to_message);

      let content = `${replyPrefix}${placeholder}${caption}`;

      if (fileId && fileName) {
        const ts = Date.now();
        const safeFileName = `${ts}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const attachmentsDir = path.join(
          resolveGroupFolderPath(group.folder),
          'attachments',
        );
        const containerPath = await this.downloadAttachment(
          fileId,
          attachmentsDir,
          safeFileName,
        );
        if (containerPath) {
          content = `${placeholder}${caption}\nFile saved at: ${containerPath}`;
        } else {
          content = `${placeholder}${caption} (file could not be downloaded)`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: senderName, content },
        'Telegram attachment stored',
      );
    };

    this.bot.on('message:photo', (ctx) => {
      const photo = ctx.message.photo?.at(-1); // largest available size
      storeNonText(ctx, '[Photo]', photo?.file_id, 'photo.jpg');
    });
    this.bot.on('message:video', (ctx) =>
      storeNonText(ctx, '[Video]', ctx.message.video?.file_id, 'video.mp4'),
    );
    this.bot.on('message:voice', (ctx) =>
      storeNonText(
        ctx,
        '[Voice message]',
        ctx.message.voice?.file_id,
        'voice.ogg',
      ),
    );
    this.bot.on('message:audio', (ctx) => {
      const name = ctx.message.audio?.file_name || 'audio';
      storeNonText(ctx, `[Audio: ${name}]`, ctx.message.audio?.file_id, name);
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(
        ctx,
        `[Document: ${name}]`,
        ctx.message.document?.file_id,
        name,
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          this.registerBotCommands().catch((err) =>
            logger.warn({ err }, 'Failed to register bot commands'),
          );
          resolve();
        },
      });
    });
  }

  /** Register bot command autocomplete suggestions with Telegram. */
  private async registerBotCommands(): Promise<void> {
    if (!this.bot) return;

    const baseCommands = [
      { command: 'ping', description: 'Check if the bot is online' },
      { command: 'chatid', description: "Get this chat's registration ID" },
    ];

    const adminCommands = [
      ...baseCommands,
      { command: 'index_status', description: 'Show vault index status' },
      { command: 'index_start', description: 'Start incremental vault index' },
      {
        command: 'index_rebuild',
        description: 'Force full vault index rebuild',
      },
      { command: 'index_abort', description: 'Abort the running index' },
      { command: 'index_restart', description: 'Restart the vault index' },
      {
        command: 'clear_context',
        description: "Clear the agent's session context for this topic",
      },
      {
        command: 'reload_commands',
        description: 'Reload bot command suggestions',
      },
    ];

    // Set default commands for all chats
    await this.bot.api.setMyCommands(baseCommands);

    // Set extended commands scoped to admins of each registered main group
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      if (!group.isMain || !jid.startsWith('tg:')) continue;
      const { chatId } = parseTgJid(jid);
      try {
        await this.bot.api.setMyCommands(adminCommands, {
          scope: { type: 'chat_administrators', chat_id: chatId },
        });
        logger.info(
          { chatId },
          'Admin commands registered for main group administrators',
        );
      } catch (err) {
        logger.warn(
          { chatId, err },
          'Failed to set commands for main group administrators',
        );
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseTgJid(jid);
      const baseOpts = {
        ...(threadId != null ? { message_thread_id: threadId } : {}),
        parse_mode: 'HTML' as const,
      };

      // Telegram has a 4096 character limit per message — split if needed.
      // If HTML parsing fails (malformed tags), retry as plain text.
      const MAX_LENGTH = 4096;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );

      for (const chunk of chunks) {
        try {
          await this.bot.api.sendMessage(chatId, chunk, baseOpts);
        } catch {
          // HTML parse error — fall back to plain text for this chunk
          const plainOpts =
            threadId != null ? { message_thread_id: threadId } : {};
          await this.bot.api.sendMessage(chatId, chunk, plainOpts);
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseTgJid(jid);
      const opts = threadId != null ? { message_thread_id: threadId } : {};
      await this.bot.api.sendChatAction(chatId, 'typing', opts);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
