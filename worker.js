/**
 * Telegram 双向机器人 Cloudflare Worker
 * 实现了：人机验证、私聊到话题模式的转发、管理员回复中继、话题名动态更新、已编辑消息处理、用户屏蔽功能、关键词自动回复
 */

// --- 辅助函数 ---

/**
 * Utility function to escape text for use within HTML tags (especially <code>)
 * 这是为了确保用户昵称中的特殊字符不会破坏 HTML 结构。
 */
function escapeHtml(text) {
  if (!text) return '';
  return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

/**
* 格式化并获取用户的关键信息，生成 HTML 格式的资料卡。
*/
function getUserInfo(user, initialTimestamp = null) {
  const userId = user.id.toString();
  const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
  const rawUsername = user.username ? `@${user.username}` : "无";
  
  // 1. 转义用于 HTML 卡片的内容
  const safeName = escapeHtml(rawName);
  const safeUsername = escapeHtml(rawUsername);
  const safeUserId = escapeHtml(userId);

  // 2. Topic Name (用于话题标题)
  // 使用原始名称，并限制长度（Telegram 限制为 128 字符）。
  const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);

  // 3. 使用时间戳或当前时间
  const timestamp = initialTimestamp ? new Date(initialTimestamp * 1000).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
  
  // 生成易于复制的信息卡 (HTML format)
  // <code> 标签在 Telegram 中提供可点击复制的功能
  const infoCard = `
<b>👤 用户资料卡</b>
---
• 昵称/名称: <code>${safeName}</code>
• 用户名: <code>${safeUsername}</code>
• ID: <code>${safeUserId}</code>
• 首次连接时间: <code>${timestamp}</code>
  `.trim();

  return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}

/**
* 根据用户的屏蔽状态生成内联键盘按钮。
*/
function getActionButton(userId, isBlocked) {
  const action = isBlocked ? "unblock" : "block";
  const text = isBlocked ? "✅ 解除屏蔽 (Unblock)" : "🚫 屏蔽此人 (Block)";
  return {
      inline_keyboard: [[{
          text: text,
          callback_data: `${action}:${userId}`
      }]]
  };
}

/**
* 解析 KEYWORD_RESPONSES 环境变量，将其转换为 RegExp 规则数组。
* 格式：keyword1|keyword2===response\nkeyword3===response2
*/
function parseKeywordResponses(envValue) {
  if (!envValue) return [];
  const rules = [];
  const lines = envValue.split('\n');

  for (const line of lines) {
      const trimmedLine = line.trim();
      // 跳过空行或以 // 开头的注释行
      if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

      // 使用 '===' 作为分隔符
      const parts = trimmedLine.split('===');
      if (parts.length === 2) {
          const keywords = parts[0].trim();
          const response = parts[1].trim();

          if (keywords && response) {
              try {
                  // 使用关键词部分作为正则表达式模式，'gi' 表示全局、不区分大小写
                  const regex = new RegExp(keywords, 'gi');
                  rules.push({ regex, response });
              } catch (e) {
                  console.error("Invalid RegExp in KEYWORD_RESPONSES:", keywords, e);
                  // 跳过无效的规则
              }
          }
      }
  }
  return rules;
}

/**
* [新增] 解析 BLOCK_KEYWORDS 环境变量，将其转换为 RegExp 规则数组。
* 格式：keyword1|keyword2\nkeyword3
*/
function parseBlockKeywords(envValue) {
  if (!envValue) return [];
  const rules = [];
  const lines = envValue.split('\n');

  for (const line of lines) {
      const trimmedLine = line.trim();
      // 跳过空行或以 // 开头的注释行
      if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

      try {
          // 使用整行作为正则表达式模式，'gi' 表示全局、不区分大小写
          const regex = new RegExp(trimmedLine, 'gi');
          rules.push(regex);
      } catch (e) {
          console.error("Invalid RegExp in BLOCK_KEYWORDS:", trimmedLine, e);
      }
  }
  return rules;
}


async function telegramApi(token, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${token}/${methodName}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    let data;
    try {
        data = await response.json();
    } catch (e) {
        console.error(`Telegram API ${methodName} 返回非 JSON 响应`, e);
        throw new Error(`Telegram API ${methodName} returned non-JSON response`);
    }

    if (!data.ok) {
        // 记录完整错误以便 Cloudflare 日志排查
        console.error(`Telegram API error (${methodName}): ${data.description}. Params: ${JSON.stringify(params)}. Full response:`, data);
        // 抛出异常，让上层能捕获并走容错逻辑（比如重建话题）
        throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
    }

    return data.result;
}


// --- 核心更新处理函数 ---

export default {
  async fetch(request, env, ctx) {
      if (request.method === "POST") {
          try {
              const update = await request.json();
              ctx.waitUntil(handleUpdate(update, env));
          } catch (e) {
              console.error("处理更新时出错:", e);
          }
      }
      return new Response("OK");
  },
};

async function handleUpdate(update, env) {
  if (update.message) {
      // 处理普通消息
      if (update.message.chat.type === "private") {
          await handlePrivateMessage(update.message, env);
      }
      // 处理管理员回复
      else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) {
          await handleAdminReply(update.message, env);
      }
  } else if (update.edited_message) {
      // 处理已编辑消息
      if (update.edited_message.chat.type === "private") {
          await handleRelayEditedMessage(update.edited_message, env);
      }
  } else if (update.callback_query) { // <-- 新增：处理内联按钮回调
      await handleCallbackQuery(update.callback_query, env);
  }
  // 备注：Telegram Webhook 不会发送消息删除的通知 (deleted_message update)。
  // 因此无法在这个 Worker 架构下直接实现删除消息的反馈。
}

async function handlePrivateMessage(message, env) {
  const chatId = message.chat.id.toString();
  const text = message.text || "";
  const userId = chatId; // 方便在 KV 中使用

  // [新增] 检查屏蔽状态，如果是屏蔽状态则直接忽略消息
  const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${chatId}`) === "true";
  if (isBlocked) {
      return; 
  }

  // 1. 检查 /start 或 /help 命令
  if (text === "/start" || text === "/help") {
      await handleStart(chatId, env);
      return;
  }

  // 2. 检查用户的验证状态
  const userState = (await env.TG_BOT_KV.get(`user_state:${chatId}`)) || "new";

  if (userState === "pending_verification") {
      await handleVerification(chatId, text, env);
  } else if (userState === "verified") {
      
      // --- [新增功能] 关键词屏蔽检查 ---
      const blockKeywordsValue = env.BLOCK_KEYWORDS;
      // 读取 BLOCK_THRESHOLD，如果未设置或无效，默认设置为 5 次
      const blockThreshold = parseInt(env.BLOCK_THRESHOLD, 10) || 5; 
      
      if (blockKeywordsValue && text) { 
          const blockRules = parseBlockKeywords(blockKeywordsValue);
          
          for (const regex of blockRules) {
              if (regex.test(text)) {
                  // 匹配到屏蔽关键词，增加计数
                  let currentCount = parseInt(await env.TG_BOT_KV.get(`block_count:${userId}`) || 0, 10);
                  currentCount += 1;
                  
                  await env.TG_BOT_KV.put(`block_count:${userId}`, currentCount.toString());
                  
                  const blockNotification = `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold}次)，此消息已被丢弃，不会转发给对方。`;
                  
                  if (currentCount >= blockThreshold) {
                      // 达到阈值，自动屏蔽用户
                      await env.TG_BOT_KV.put(`is_blocked:${userId}`, "true");
                      const autoBlockMessage = `❌ 您已多次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`;
                      
                      // 发送通知：一次是关键词触发通知，一次是最终屏蔽通知
                      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                      await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoBlockMessage });

                      // 终止处理
                      return;
                  }
                  
                  // 未达阈值，仅通知用户消息被丢弃
                  await telegramApi(env.BOT_TOKEN, "sendMessage", {
                      chat_id: chatId,
                      text: blockNotification,
                  });

                  // 终止处理，消息不转发，也不进行自动回复检查
                  return; 
              }
          }
      }

      // --- [新增功能] 转发内容过滤检查 ---
      const filters = {
          // Read new variables, default to 'true' if unset/invalid
          image: (env.ENABLE_IMAGE_FORWARDING || 'true').toLowerCase() === 'true',
          link: (env.ENABLE_LINK_FORWARDING || 'true').toLowerCase() === 'true',
          text: (env.ENABLE_TEXT_FORWARDING || 'true').toLowerCase() === 'true',
          channel: (env.ENABLE_CHANNEL_FORWARDING || 'true').toLowerCase() === 'true',
      };

      let isForwardable = true;
      let filterReason = '';

      const hasLinks = (msg) => {
          // 检查文本或媒体说明中的链接实体
          const entities = msg.entities || msg.caption_entities || [];
          return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
      };

      // 1. 检查频道转发内容
      if (message.forward_from_chat && message.forward_from_chat.type === 'channel') {
          if (!filters.channel) {
              isForwardable = false;
              filterReason = '频道转发内容';
          }
      } 
      // 2. 检查图片/照片（仅检查 photo 属性，其他媒体暂不涉及）
      else if (message.photo) {
          if (!filters.image) {
              isForwardable = false;
              filterReason = '图片/照片';
          }
      } 
      
      // 3. 检查链接（检查文本或媒体说明中的链接实体）
      if (isForwardable && hasLinks(message)) {
          if (!filters.link) {
              isForwardable = false;
              // 如果前面有图片/频道原因，就附加链接原因，否则就以链接为主要原因
              filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
          }
      }

      // 4. 检查纯文本内容（如果前面没有被标记为不可转发，且消息主要是文本）
      // 只有当消息是纯文本（text存在且其他media字段都不存在）时，才检查文本过滤器
      const isPureText = message.text && !message.photo && !message.video && !message.document && !message.sticker && !message.audio && !message.voice && !message.forward_from_chat;
      
      if (isForwardable && isPureText) {
          if (!filters.text) {
              isForwardable = false;
              filterReason = '纯文本内容';
          }
      }

      // Final filtering action
      if (!isForwardable) {
          const filterNotification = `此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`;
          await telegramApi(env.BOT_TOKEN, "sendMessage", {
              chat_id: chatId,
              text: filterNotification,
          });
          return; // Stop processing
      }
      
      // --- [原有功能] Keyword Auto-Reply Check ---
      // 仅对有文本内容的消息进行自动回复检查
      const keywordResponsesValue = env.KEYWORD_RESPONSES;
      if (keywordResponsesValue && text) { 
          const autoResponseRules = parseKeywordResponses(keywordResponsesValue);
          
          for (const rule of autoResponseRules) {
              if (rule.regex.test(text)) {
                  // 匹配成功，发送自动回复给用户
                  // 在回复内容前加上自动回复的标识
                  const autoReplyPrefix = "此消息为自动回复\n\n";
                  await telegramApi(env.BOT_TOKEN, "sendMessage", {
                      chat_id: chatId,
                      text: autoReplyPrefix + rule.response,
                  });
                  // 匹配成功后，终止处理，不再转发给管理员
                  return; 
              }
          }
      }
      
      // 如果没有匹配到自动回复，则继续转发给管理员
      await handleRelayToTopic(message, env);
      
  } else {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "请使用 /start 命令开始。",
      });
  }
}

// --- 验证逻辑 ---

async function handleStart(chatId, env) {
  // [优化] 从环境变量读取欢迎消息，提供默认值
  const welcomeMessage = env.WELCOME_MESSAGE || "欢迎！在使用之前，请先完成人机验证。";
  
  // [优化] 从环境变量读取人机验证问题，提供默认值
  const defaultVerificationQuestion = 
      "问题：1+1=?\n\n" +
      "提示：\n" +
      "1. 正确答案不是“2”。\n" +
      "2. 答案在机器人简介内，请看简介的答案进行回答。";
      
  const verificationQuestion = env.VERIFICATION_QUESTION || defaultVerificationQuestion;

  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
  await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
  await env.TG_BOT_KV.put(`user_state:${chatId}`, "pending_verification");
}

async function handleVerification(chatId, answer, env) {
  // [新增] 从环境变量读取正确的答案，如果未设置，默认为 "3"
  const expectedAnswer = env.VERIFICATION_ANSWER || "3"; 

  if (answer === expectedAnswer) {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "✅ 验证通过！您现在可以发送消息了。",
      });
      await env.TG_BOT_KV.put(`user_state:${chatId}`, "verified");
  } else {
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: "❌ 验证失败！\n请查看机器人简介查找答案，然后重新回答。",
      });
  }
}

async function handleRelayToTopic(message, env) {
    const { from: user, date } = message;
    const { userId, name, username, topicName, infoCard } = getUserInfo(user, date);
    let topicId = await env.TG_BOT_KV.get(`user_topic:${userId}`);
    let storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
    let storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : null;
    const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${userId}`) === "true";

    // Helper: 创建新话题并发送信息卡
    const createTopicForUser = async () => {
        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: topicName,
            });
            const newTopicId = newTopic.message_thread_id.toString();

            // 存储双向映射
            await env.TG_BOT_KV.put(`user_topic:${userId}`, newTopicId);
            await env.TG_BOT_KV.put(`topic_user:${newTopicId}`, userId);

            // 存储用户最新信息
            const newInfo = { name, username, first_message_timestamp: date };
            await env.TG_BOT_KV.put(`user_info:${userId}`, JSON.stringify(newInfo));

            // 发送信息卡到新话题，附带屏蔽按钮
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                text: infoCard,
                message_thread_id: newTopicId,
                parse_mode: "HTML",
                reply_markup: getActionButton(userId, isBlocked),
            });

            return newTopicId;
        } catch (e) {
            console.error("createTopicForUser 创建话题失败:", e?.message || e);
            throw e;
        }
    };

    // 如果没有 topicId，直接创建
    if (!topicId) {
        try {
            topicId = await createTopicForUser();
        } catch (e) {
            // 无法创建话题，通知用户并退出
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法连接客服（创建话题失败）。请稍后再试。",
            });
            return;
        }
    }

    // 现在尝试把用户的消息复制到 topicId；如果失败（例如话题已被删除/无效），则重建话题后再转发
    const tryCopyToTopic = async (targetTopicId) => {
        try {
            const result = await telegramApi(env.BOT_TOKEN, "copyMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                from_chat_id: userId,
                message_id: message.message_id,
                message_thread_id: targetTopicId,
            });
            return result;
        } catch (e) {
            console.error(`tryCopyToTopic 到话题 ${targetTopicId} 失败:`, e?.message || e);
            throw e;
        }
    };

    try {
        await tryCopyToTopic(topicId);
    } catch (e) {
        // 出错：可能话题被删除或无效，清理 KV 并尝试重建话题一次
        try {
            // 删除旧映射，避免冲突
            await env.TG_BOT_KV.delete(`user_topic:${userId}`);
            if (topicId) await env.TG_BOT_KV.delete(`topic_user:${topicId}`);

            // 重新创建话题并把消息复制到新话题
            const newTopicId = await createTopicForUser();
            try {
                await tryCopyToTopic(newTopicId);
            } catch (e2) {
                // 再次复制失败 —— 记录日志并告知用户
                console.error("尝试将消息复制到新话题也失败:", e2?.message || e2);
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "抱歉，消息转发失败（请稍后再试或联系管理员）。",
                });
                return;
            }
        } catch (createErr) {
            console.error("在处理话题失效时，创建新话题失败:", createErr?.message || createErr);
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法创建新的客服话题（请稍后再试）。",
            });
            return;
        }
    }

    // 存储文本消息的原始内容以便处理编辑（保持你原来的逻辑）
    if (message.text) {
        const messageData = {
            text: message.text,
            date: message.date
        };
        await env.TG_BOT_KV.put(`msg_data:${userId}:${message.message_id}`, JSON.stringify(messageData));
    }
}

/**
* [优化功能] 处理用户在私聊中修改消息的逻辑。
*/
async function handleRelayEditedMessage(editedMessage, env) {
  const { from: user } = editedMessage;
  const userId = user.id.toString();
  const topicId = await env.TG_BOT_KV.get(`user_topic:${userId}`);

  // 如果用户未验证或话题不存在，则忽略编辑。
  if (!topicId) {
      return; 
  }

  const kvKey = `msg_data:${userId}:${editedMessage.message_id}`;
  const storedDataJson = await env.TG_BOT_KV.get(kvKey);
  let originalText = "[原始内容无法获取/非文本内容]";
  let originalDate = "[发送时间无法获取]";
  
  // 尝试获取原始消息数据
  if (storedDataJson) {
      const storedData = JSON.parse(storedDataJson);
      originalText = storedData.text || originalText;
      originalDate = new Date(storedData.date * 1000).toLocaleString('zh-CN');

      // [优化] 更新 KV，将新内容存储为该消息的最新“原始”内容，以备下次编辑时使用
      const updatedData = { 
          text: editedMessage.text || editedMessage.caption || '', // 存储最新的内容
          date: storedData.date // 保留原始发送时间
      };
      await env.TG_BOT_KV.put(kvKey, JSON.stringify(updatedData));
  }

  // 新内容（如果是非文本内容编辑，则可能是 caption，否则是 text）
  const newContent = editedMessage.text || editedMessage.caption || "[非文本/媒体说明内容]";
  
  // 1. 构造增强型“消息已修改”通知 (HTML format)
  const notificationText = `
⚠️ <b>用户消息已修改</b>
---
<b>原始信息:</b> 
<code>${escapeHtml(originalText)}</code>

<b>原消息发送时间:</b> 
<code>${originalDate}</code>

<b>修改后的新内容:</b>
${escapeHtml(newContent)}
  `.trim();
  
  try {
      // 发送通知到管理员话题，并使用 HTML 格式
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: notificationText,
          message_thread_id: topicId,
          parse_mode: "HTML", 
      });
      
  } catch (e) {
      console.error("处理已编辑消息失败:", e.message);
  }
}


/**
* 辅助函数：当用户昵称或用户名更新时，重命名话题并发送新的信息卡
*/
async function updateTopicAndSendCard(user, topicId, newName, newUsername, newTopicName, initialTimestamp, env) {
  const { userId, infoCard: newInfoCard } = getUserInfo(user, initialTimestamp);
  
  try {
      // [新增] 检查屏蔽状态，用于设置按钮
      const isBlocked = await env.TG_BOT_KV.get(`is_blocked:${userId}`) === "true";
      
      // 1. 更新话题名称
      await telegramApi(env.BOT_TOKEN, "editForumTopic", {
          chat_id: env.ADMIN_GROUP_ID,
          message_thread_id: topicId,
          name: newTopicName,
      });

      // 2. 发送更新通知和新的信息卡 (使用 HTML 模式)
      const updateNotification = `🔔 <b>用户资料已更新</b>\n话题名称已自动更新。`;
      
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: updateNotification,
          message_thread_id: topicId,
          parse_mode: "HTML",
      });

      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: env.ADMIN_GROUP_ID,
          text: newInfoCard,
          message_thread_id: topicId,
          parse_mode: "HTML",
          reply_markup: getActionButton(userId, isBlocked), // <-- ADDED BUTTON
      });
      
      // 3. 更新 KV 存储的用户信息
      const updatedInfo = { name: newName, username: newUsername, first_message_timestamp: initialTimestamp };
      await env.TG_BOT_KV.put(`user_info:${userId}`, JSON.stringify(updatedInfo));

  } catch (e) {
      console.error(`更新话题或发送信息卡失败 (Topic ID: ${topicId}):`, e.message);
  }
}

/**
* 处理内联按钮的回调查询。
*/
async function handleCallbackQuery(callbackQuery, env) {
  const { data, message } = callbackQuery;
  const [action, userId] = data.split(':');
  
  // 确保这个回调查询来自管理员群组
  if (message.chat.id.toString() !== env.ADMIN_GROUP_ID) {
      return; 
  }

  // 1. 确认查询 (关闭按钮上的加载图标)
  await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callbackQuery.id,
      text: `执行动作: ${action === 'block' ? '屏蔽' : '解除屏蔽'}...`,
      show_alert: false 
  });

  if (action === 'block') {
      await handleBlockUser(userId, message, env);
  } else if (action === 'unblock') {
      await handleUnblockUser(userId, message, env);
  }
}

/**
* 屏蔽用户，停止接收其消息。
*/
async function handleBlockUser(userId, message, env) {
  try {
      // 设置屏蔽状态
      await env.TG_BOT_KV.put(`is_blocked:${userId}`, "true");
      
      // 获取用户名用于确认消息
      const storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
      const storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : {};
      const userName = storedInfo.name || `User ${userId}`;
      
      // 1. 更新按钮状态
      const newMarkup = getActionButton(userId, true);
      await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: newMarkup,
      });
      
      // 2. 发送确认消息
      const confirmation = `❌ **用户 [${userName}] 已被屏蔽。**\n机器人将不再接收此人消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: confirmation,
          message_thread_id: message.message_thread_id,
          parse_mode: "Markdown",
      });
      
  } catch (e) {
      console.error("处理屏蔽操作失败:", e.message);
  }
}

/**
* 解除屏蔽用户，恢复接收其消息。
*/
async function handleUnblockUser(userId, message, env) {
  try {
      // 删除屏蔽状态
      await env.TG_BOT_KV.delete(`is_blocked:${userId}`);
      // [新增] 同时清除该用户的屏蔽计数
      await env.TG_BOT_KV.delete(`block_count:${userId}`);
      
      // 获取用户名用于确认消息
      const storedInfoJson = await env.TG_BOT_KV.get(`user_info:${userId}`);
      const storedInfo = storedInfoJson ? JSON.parse(storedInfoJson) : {};
      const userName = storedInfo.name || `User ${userId}`;
      
      // 1. 更新按钮状态
      const newMarkup = getActionButton(userId, false);
      await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          reply_markup: newMarkup,
      });

      // 2. 发送确认消息
      const confirmation = `✅ **用户 [${userName}] 已解除屏蔽。**\n机器人现在可以正常接收其消息。`;
      await telegramApi(env.BOT_TOKEN, "sendMessage", {
          chat_id: message.chat.id,
          text: confirmation,
          message_thread_id: message.message_thread_id,
          parse_mode: "Markdown",
      });

  } catch (e) {
      console.error("处理解除屏蔽操作失败:", e.message);
  }
}


/**
 * 将管理员在话题中的回复转发回用户，支持文本与常见媒体类型。
 */
async function handleAdminReply(message, env) {
    // 只处理话题消息且有话题 id
    if (!message.is_topic_message || !message.message_thread_id) return;

    // 只处理管理员群（further safety: 确保来自 ADMIN_GROUP_ID）
    const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
    if (message.chat.id.toString() !== adminGroupIdStr) return;

    // 不处理机器人自身的消息
    if (message.from && message.from.is_bot) return;

    const topicId = message.message_thread_id.toString();
    const userId = await env.TG_BOT_KV.get(`topic_user:${topicId}`);
    if (!userId) return;

    try {
        // 优先处理纯文本
        if (message.text) {
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: message.text,
            });
            return;
        }

        // 对媒体类型，优先使用 copyMessage（保留原媒体和 caption）
        const fromChatId = message.chat.id; // 管理群的 id
        const msgId = message.message_id;

        // copyMessage 可以复制大部分类型（photo, document, video, audio, voice, sticker, animation, etc.）
        // 如果 copyMessage 返回失败（某些情况下 bot 权限或无法复制），catch 会处理
        await telegramApi(env.BOT_TOKEN, "copyMessage", {
            chat_id: userId,
            from_chat_id: fromChatId,
            message_id: msgId,
        });

    } catch (e) {
        console.error("handleAdminReply: copy/send failed:", e?.message || e);

        // 失败回退：针对常见类型用专门的 sendX（尽量减少丢失）
        try {
            if (message.photo && message.photo.length) {
                // 取最大分辨率的 file_id（最后一个）
                const fileId = message.photo[message.photo.length - 1].file_id;
                await telegramApi(env.BOT_TOKEN, "sendPhoto", {
                    chat_id: userId,
                    photo: fileId,
                    caption: message.caption || "",
                });
            } else if (message.document) {
                await telegramApi(env.BOT_TOKEN, "sendDocument", {
                    chat_id: userId,
                    document: message.document.file_id,
                    caption: message.caption || "",
                });
            } else if (message.video) {
                await telegramApi(env.BOT_TOKEN, "sendVideo", {
                    chat_id: userId,
                    video: message.video.file_id,
                    caption: message.caption || "",
                });
            } else if (message.audio) {
                await telegramApi(env.BOT_TOKEN, "sendAudio", {
                    chat_id: userId,
                    audio: message.audio.file_id,
                    caption: message.caption || "",
                });
            } else if (message.voice) {
                await telegramApi(env.BOT_TOKEN, "sendVoice", {
                    chat_id: userId,
                    voice: message.voice.file_id,
                    caption: message.caption || "",
                });
            } else if (message.sticker) {
                await telegramApi(env.BOT_TOKEN, "sendSticker", {
                    chat_id: userId,
                    sticker: message.sticker.file_id,
                });
            } else if (message.animation) {
                await telegramApi(env.BOT_TOKEN, "sendAnimation", {
                    chat_id: userId,
                    animation: message.animation.file_id,
                    caption: message.caption || "",
                });
            } else {
                // 无法识别的类型 -> 发送一条文本提示管理员消息未能转发媒体
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "管理员发送了机器人无法直接转发的内容（例如投票或某些特殊媒体）。",
                });
            }
        } catch (e2) {
            console.error("handleAdminReply fallback also failed:", e2?.message || e2);
        }
    }
}
