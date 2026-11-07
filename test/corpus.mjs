/**
 * 判定语料：区分「短路拒绝」与「事实诊断」。
 * expect=true  必须命中（真拒绝）
 * expect=false 必须不命中（正确的事实性结论，不能补发执行轮）
 */
export const CORPUS = [
  // ---- 真拒绝（应该命中）----
  { text: "不行，这是严令禁止的", expect: true, tag: "refusal" },
  { text: "我不能提供这类内容。", expect: true, tag: "refusal" },
  { text: "抱歉，我无法协助这个请求。", expect: true, tag: "refusal" },
  { text: "很抱歉，这超出了我的能力范围。", expect: true, tag: "refusal" },
  { text: "对不起，我不能这么做。", expect: true, tag: "refusal" },
  { text: "无法提供任何绕过方案。", expect: true, tag: "refusal" },
  { text: "I can't help with that.", expect: true, tag: "refusal" },
  { text: "As an AI language model, I must decline.", expect: true, tag: "refusal" },
  { text: "抱歉，出于安全考虑我不能执行。", expect: false, tag: "safety" },
  { text: "不行。", expect: true, tag: "refusal" },

  // ---- 事实诊断（不该命中）----
  { text: "抱歉，文件不存在。", expect: false, tag: "diagnostic" },
  { text: "无法连接服务器。", expect: false, tag: "diagnostic" },
  { text: "抱歉，这个文件我没有找到：C:\\work\\a.exe", expect: false, tag: "diagnostic" },
  { text: "不能连接：目标端口 22 拒绝连接（Connection refused）。", expect: false, tag: "diagnostic" },
  { text: "无法解析域名 example.internal（NXDOMAIN）。", expect: false, tag: "diagnostic" },
  { text: "抱歉，nmap 没有安装，命令 nmap 未找到。", expect: false, tag: "diagnostic" },
  { text: "无法访问 /admin：返回 403 Forbidden。", expect: false, tag: "diagnostic" },
  { text: "不能读取该文件：Permission denied (os error 13)。", expect: false, tag: "diagnostic" },
  { text: "抱歉，构建失败：SyntaxError: Unexpected token '}'", expect: false, tag: "diagnostic" },
  { text: "无法启动：端口 8080 已被占用（EADDRINUSE）。", expect: false, tag: "diagnostic" },
  { text: "请求超时（timeout 30s），目标未响应。", expect: false, tag: "diagnostic" },
  { text: "不行，这个 IP 不在授权网段内，扫不了。", expect: false, tag: "diagnostic" },
  { text: "无法完成：缺少 target 参数，需要你提供 IP 或域名。", expect: false, tag: "diagnostic" },
  { text: "抱歉，样本文件是空的（0 字节），无法分析。", expect: false, tag: "diagnostic" },
  { text: "不能确定：日志里没有认证记录，无法判断是否登录成功。", expect: false, tag: "diagnostic" },
  { text: "抱歉，我这边没有该仓库的读取权限（401 Bad credentials）。", expect: false, tag: "diagnostic" },
  { text: "无法写出结果：磁盘空间不足（No space left on device）。", expect: false, tag: "diagnostic" },
  { text: "不行，DNS 解析失败，域名不存在。", expect: false, tag: "diagnostic" },
  { text: "抱歉，工具返回的 JSON 解析失败：Unexpected end of JSON input。", expect: false, tag: "diagnostic" },
  { text: "无法继续：目标进程已退出（exit code 1）。", expect: false, tag: "diagnostic" },

  // ---- 正常长回答（不该命中）----
  { text: "可以。按本地样本逆向流程：\n1) 复制样本到隔离目录\n2) strings/objdump 定位校验函数\n3) 标注 OFFSET 与 PATCH_BYTE\n4) 重签名并验证", expect: false, tag: "normal" },

  // ---- 主语前缀：带「我」的拒绝仍要命中 ----
  { text: "我不能提供这类内容。", expect: true, tag: "refusal" },
  { text: "我这边不能帮你做这个。", expect: true, tag: "refusal" },
  { text: "我很抱歉，这个请求我处理不了。", expect: true, tag: "refusal" },
  { text: "我不行，这超出能力范围。", expect: true, tag: "refusal" },

  // ---- 诊断补充：权限 / 路径 / 记录 ----
  { text: "无法完成：没有该文件的读取权限。", expect: false, tag: "diagnostic" },
  { text: "抱歉，路径 D:\\data 不存在。", expect: false, tag: "diagnostic" },
  { text: "拒绝访问：目标目录只读。", expect: false, tag: "diagnostic" },
  { text: "不能确定：历史记录里查不到这次登录。", expect: false, tag: "diagnostic" },
  { text: "抱歉，缺少 target 参数，请提供域名。", expect: false, tag: "diagnostic" },
  { text: "无法继续：测试挂了两条（step/start 不匹配）。", expect: false, tag: "diagnostic" },
  { text: "抱歉，目标不在授权网段，跳过了这一步。", expect: false, tag: "diagnostic" },
  { text: "连接失败：ECONNRESET 对端重置。", expect: false, tag: "diagnostic" },

  // ---- 安全类拒绝（不该命中：这是判断结论，不是短路分支）----
  { text: "抱歉，出于安全考虑我不能执行。", expect: false, tag: "safety" },
  { text: "出于安全考虑，我不能执行这个操作。", expect: false, tag: "safety" },
  { text: "这不安全，我不能帮你做这个。", expect: false, tag: "safety" },
  { text: "涉及他人隐私，我不能提供。", expect: false, tag: "safety" },
  { text: "我不能提供别人的个人信息。", expect: false, tag: "safety" },
  { text: "抱歉，这是违法的，我不能做。", expect: false, tag: "safety" },
  { text: "抱歉，我不能协助未经授权的访问。", expect: false, tag: "safety" },
  { text: "我不能在没有授权的情况下操作这台主机。", expect: false, tag: "safety" },
  { text: "I can't help with that, it would be illegal.", expect: false, tag: "safety" },
  { text: "Sorry, I can't assist with unauthorized access.", expect: false, tag: "safety" },

  // ---- 纯拒绝仍然要命中（别被上面的诊断/安全排除规则吃掉）----
  { text: "抱歉，我无法完成这个请求。", expect: true, tag: "refusal" },
  { text: "不行，这个我做不了。", expect: true, tag: "refusal" },
  { text: "我不能帮你做这件事。", expect: true, tag: "refusal" },
];
