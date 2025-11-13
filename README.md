Telegram 转发机器人 Cloudflare Worker 详细使用说明书

本文档是针对您提供的 Telegram Relay Bot Worker (Optimized):src/index.js 代码编写的详细使用指南。该 Worker 旨在建立一个私聊用户与管理员群组（通过话题）之间的双向通信桥梁。

第一部分：项目简介与工作原理

1.1 核心功能

私聊转发到话题 (Forum Topic): 用户私聊机器人的消息会被转发到管理员群组中的一个独立话题。

话题名动态管理: 话题名包含用户昵称和 ID，如果用户昵称更改，话题名称会自动更新。

管理员回复中继: 管理员在话题内回复消息，内容会自动转发回该用户私聊。

人机验证 (Captcha): 新用户首次使用前需通过问答验证，防止垃圾信息。

已编辑消息通知: 用户修改已发送的消息时，Worker 会在对应话题中发送通知，显示原始内容和修改后内容。

用户屏蔽与解屏蔽: 管理员可以通过话题内卡片上的内联按钮一键屏蔽/解屏蔽用户。

关键词自动屏蔽 (Anti-Spam): 可配置关键词列表和阈值，自动屏蔽发送垃圾内容的用户。

关键词自动回复: 可配置关键词，实现对常见问题的自动回复，减轻管理员负担。

内容类型过滤 (新增): 可精细控制接收的转发消息类型，包括图片、链接、纯文本和频道转发内容。

1.2 工作环境

本项目必须部署在 Cloudflare Worker 环境中，并使用 Cloudflare KV (Key-Value) 存储进行数据持久化（例如存储用户 ID、话题 ID 和屏蔽状态）。

第二部分：环境配置（必备条件）

要部署此 Worker，您需要准备以下资源：

2.1 Telegram 设置

创建 Bot: 使用 Telegram 官方的 @BotFather 创建一个新的机器人，并获取您的 Bot Token。

创建管理员群组: 创建一个超级群组（Supergroup），并将其转换为话题模式 (Forum)。

获取群组 ID: 将您的 Bot 添加为该群组的管理员。向群组发送一条消息，并通过 https://api.telegram.org/bot<您的BOT_TOKEN>/getUpdates 接口获取该群组的 ID。群组 ID 通常以 -100 开头。

2.2 Cloudflare 设置

创建 Worker: 在 Cloudflare 控制台创建一个新的 Worker。

创建 KV Namespace: 创建一个 KV 存储空间，例如命名为 TG_BOT_KV。

第三部分：环境变量配置

在您的 Cloudflare Worker 设置页面，您必须配置以下环境变量（Variables）。

3.1 必填变量 (Required)

变量名称

类型

描述

BOT_TOKEN

文本

您从 @BotFather 获得的 Telegram 机器人 Token。

ADMIN_GROUP_ID

文本

您的管理员群组 ID (必须是话题模式群组，如 -100XXXXXXXXXX)。

3.2 必填 KV 绑定 (KV Bindings)

变量名称

类型

描述

TG_BOT_KV

KV 命名空间

绑定您创建的 KV 存储空间。

3.3 验证功能配置 (Optional)

变量名称

类型

默认值

描述

VERIFICATION_ANSWER

文本

"3"

用户通过验证的正确答案。请确保将该答案放在机器人简介中，以供用户查找。

VERIFICATION_QUESTION

文本

(见代码)

发送给新用户的验证问题。如果未设置，使用代码中的默认问题。

WELCOME_MESSAGE

文本

(见代码)

用户发送 /start 时收到的欢迎语。

3.4 关键词过滤与自动回复配置 (Optional)

变量名称

类型

默认值

描述

KEYWORD_RESPONSES

文本

空

自动回复规则。格式：关键词1|关键词2===回复内容\n关键词3===回复内容2。关键词部分被视为正则表达式。

BLOCK_KEYWORDS

文本

空

反垃圾关键词。格式：关键词1|关键词2\n关键词3。如果消息匹配任何关键词，将增加用户的屏蔽计数。

BLOCK_THRESHOLD

数字

5

自动屏蔽阈值。用户匹配 BLOCK_KEYWORDS 的次数达到此阈值后，将被自动屏蔽。

3.5 消息类型转发开关 (Optional)

这些变量用于精细控制 Worker 转发给管理员的消息类型。所有未设置或设为非 false 的值，都默认为 启用 (true)。

变量名称

类型

默认值

描述

ENABLE_IMAGE_FORWARDING

布尔

true

设置为 false 则禁用转发图片（Photo/Picture）类型的消息。

ENABLE_LINK_FORWARDING

布尔

true

设置为 false 则禁用转发包含 URL 或 text_link 实体的消息。

ENABLE_TEXT_FORWARDING

布尔

true

设置为 false 则禁用转发纯文本消息。

ENABLE_CHANNEL_FORWARDING

布尔

true

设置为 false 则禁用转发来自 Telegram 频道的转发内容。

第四部分：KV 存储结构

Worker 使用 TG_BOT_KV 存储以下信息：

KV Key 格式

存储内容

描述

user_state:<user_id>

"new", "pending_verification", "verified"

用户的验证状态。

user_topic:<user_id>

<topic_id>

私聊用户 ID 对应的话题 ID。

topic_user:<topic_id>

<user_id>

话题 ID 对应的私聊用户 ID（反向映射）。

user_info:<user_id>

JSON 对象

存储用户的昵称、用户名和首次消息时间戳，用于话题更新。

is_blocked:<user_id>

"true"

如果用户被屏蔽，该 Key 存在且值为 "true"。

block_count:<user_id>

整数 (字符串)

用户的关键词触发次数（用于自动屏蔽）。

msg_data:<user_id>:<msg_id>

JSON 对象

存储用户私聊消息的原始内容和发送时间，用于编辑消息通知。

第五部分：功能操作说明

5.1 人机验证流程

新用户私聊机器人。

机器人发送 WELCOME_MESSAGE 和 VERIFICATION_QUESTION。

用户必须发送与 VERIFICATION_ANSWER 匹配的回复才能通过验证。

通过后，用户状态从 pending_verification 变为 verified，机器人开始转发消息。

5.2 消息转发与回复

用户到管理员: 用户在私聊中发送消息（如果未被过滤或自动回复处理），Worker 会将其 copyMessage 到管理员群组中对应的话题。

管理员到用户: 管理员在对应的话题内回复该用户的消息，该回复内容会被 Worker 转发回给该私聊用户。

5.3 用户屏蔽与管理

当新用户消息首次转发时，Worker 会在话题内发送用户资料卡，并附带一个 🚫 屏蔽此人 (Block) 内联按钮。

管理员点击该按钮，用户状态在 KV 中被标记为 is_blocked:true。

按钮文本自动更新为 ✅ 解除屏蔽 (Unblock)。

被屏蔽的用户发送的任何消息都将被 Worker 默默忽略，不会转发给管理员。

管理员点击 Unblock 按钮即可恢复接收该用户消息，并清除了其自动屏蔽计数。

5.4 消息类型过滤（重点）

Worker 在转发前会进行严格检查：

消息类型判断

检查逻辑

过滤开关

频道转发

消息中包含 forward_from_chat 且类型为 channel。

ENABLE_CHANNEL_FORWARDING

图片

消息中包含 photo 字段。

ENABLE_IMAGE_FORWARDING

链接

消息的 text 或 caption 实体中包含 url 或 text_link 类型。

ENABLE_LINK_FORWARDING

纯文本

消息中仅包含 text，且无其他媒体或转发属性。

ENABLE_TEXT_FORWARDING

如果某条消息因被过滤而没有转发，用户将收到通知：此消息已被过滤：[原因]。根据设置，此类内容不会转发给管理员。

第六部分：部署步骤（高层指南）

准备代码: 将 src/index.js 代码粘贴到您的 Cloudflare Worker 代码编辑器中。

配置变量: 在 Worker 设置中，按照第三部分的要求配置所有必要的环境变量和 KV 命名空间绑定。

保存并部署: 保存 Worker 代码。

设置 Webhook: 使用以下命令将您的 Worker URL 设置为 Telegram Bot 的 Webhook。

[https://api.telegram.org/bot](https://api.telegram.org/bot)<您的BOT_TOKEN>/setWebhook?url=<您的Worker的URL>


例如：https://api.telegram.org/bot123456:ABC-DEF/setWebhook?url=https://your-worker-name.your-account.workers.dev

部署完成后，Bot 将开始运行，并使用您配置的验证和过滤规则来管理私聊用户消息。
