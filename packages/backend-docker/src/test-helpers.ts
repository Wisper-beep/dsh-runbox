/**
 * 测试辅助：构造 Docker 的多路复用流帧。
 *
 * 独立成文件而不是塞进测试里，是因为帧格式是**外部契约**——拆帧和解帧必须
 * 用同一份定义，否则测试会跟着实现一起错。
 *
 * @module @dsh-runbox/backend-docker/test-helpers
 */

/**
 * 构造一个 Docker 多路复用帧：`[streamType, 0, 0, 0, size(4, BE), payload]`。
 * @param streamType - 1 为 stdout，2 为 stderr。
 * @param text - 载荷文本，按 UTF-8 编码。
 * @returns 完整的帧缓冲区。
 */
export function encodeFrame(streamType: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = streamType
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}
