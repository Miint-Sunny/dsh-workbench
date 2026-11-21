/**
 * 网页发布（dsh-workbench/pages）共用的错误类型和字节数写法。错误的 message 会原样交给模型
 * （工具抛错时 DSH 把它作为工具结果给模型），也会显示给用户（对话里的工具行、文件预览的
 * 「发布为页面」），所以写成完整的一句话：哪个文件、为什么、怎么办。
 * 本模块不 import 任何 @deepseek-ai 包。
 */

/** 网页发布的错误：code 供路由选 HTTP 状态、供测试断言；message 给用户和模型看。 */
export class PagesError extends Error {
  /**
   * @param {string} code 错误种类，如 'not-found'、'outside-workspace'、'asset-too-large'。
   * @param {string} message 给用户和模型看的原因。
   * @param {{size?: number}} [details] 附加信息：超限时文件的字节数。
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PagesError'
    this.code = code
    this.size = details.size
  }
}

const KIB = 1024
const MIB = 1024 * 1024

/**
 * 字节数的写法：不到 1 KB 写字节，不到 1 MiB 写 KB，再大写 MiB（样稿里的「182 KB」「6.2 MiB」）。
 * 网页端 src/client/pages.js 有一份同样写法的 pagesFormatBytes。
 * @param {number} bytes 字节数。
 * @returns {string} 例如「182 KB」「6.2 MiB」「4 MiB」。
 */
export function formatBytes(bytes) {
  if (bytes < KIB) return `${bytes} 字节`
  if (bytes < MIB) return `${Math.round(bytes / KIB)} KB`
  const mib = bytes / MIB
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
}
