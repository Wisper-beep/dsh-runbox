/**
 * 测试辅助：帧构造与"能不能跑集成测试"的判定。
 *
 * 独立成文件而不是塞进测试里，是因为帧格式是**外部契约**——拆帧和解帧必须
 * 用同一份定义，否则测试会跟着实现一起错。
 *
 * @module @dsh-runbox/backend-docker/test-helpers
 */

import { candidateEndpoints, engineRequest, selectEndpoint } from './engine.ts'

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

/**
 * 判断是否有**可用的 Linux 容器引擎**。
 *
 * 只看 `/_ping` 不够：GitHub 的 windows-latest runner 上跑着 Windows 容器引擎，
 * 它能应答 ping 也能建容器，但不支持只读 rootfs。集成用例测的是 Linux 容器的
 * 行为，因此必须把这一层也判掉——否则失败信息会指向错误的地方。
 *
 * @returns 可用时 `false`（表示"不必跳过"）；否则返回跳过原因。
 */
export async function linuxEngineSkipReason(): Promise<string | false> {
  const { endpoint } = await selectEndpoint(candidateEndpoints(), 1200)
  if (!endpoint) {
    return 'docker engine unavailable'
  }
  try {
    const info = await engineRequest(endpoint, 'GET', '/info', undefined, 5000)
    const osType = (JSON.parse(info.body.toString('utf8')) as { OSType?: string }).OSType
    if (osType !== 'linux') {
      return `engine runs ${osType ?? 'unknown'} containers, not linux`
    }
    return false
  } catch (error) {
    return `engine info unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}
