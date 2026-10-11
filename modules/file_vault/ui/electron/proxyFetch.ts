/**
 * 让更新请求跟着系统代理走。Node 的 fetch 不读系统代理：开着代理软件但没开 TUN 的机器上，
 * 它会绕开代理直连 GitHub，跨境线路上慢一到两个数量级。
 *
 * 不换 Chromium 的 net.fetch：它对同一主机走 HTTP/2 单连接，16 路分段会挤在一条 TCP 上，
 * 多连接提速就没了。这里每个请求经代理各开一条 CONNECT 隧道（Node 内置的 Agent 代理支持），
 * 仍是各自独立、可复用的 TCP 连接。
 *
 * 代理只是通路不是信任：隧道里照常校验 TLS 证书，地址白名单和验签都在调用方。
 * 走不通就退回直连——代理只许让下载更快，不许让它更坏。
 *
 * 不依赖 Electron，代理解析由调用方注入。
 */

import type { IncomingMessage } from 'node:http'
import https from 'node:https'

export interface ProxyEndpoint {
  host: string
  port: number
}

/** 返回 Chromium 风格的通路串，如 `PROXY 127.0.0.1:7890; DIRECT`。 */
export type ResolveProxy = (url: string) => Promise<string>

const ROUTE_TTL_MS = 60_000
/** 走不通这么多次，本次运行就不再试代理。 */
const MAX_STRIKES = 3

/**
 * 取首选通路。只认 HTTP 代理（`PROXY host:port`）；首选是 DIRECT、SOCKS 或 HTTPS 代理时返回
 * null，即直连。
 */
export function parseProxyRule(rule: string): ProxyEndpoint | null {
  const first = (rule.split(';')[0] ?? '').trim()
  const match = /^PROXY\s+(\[[0-9a-f:.]+\]|[^\s:;]+):(\d{1,5})$/i.exec(first)
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65_535) return null
  return { host: match[1].replace(/^\[|\]$/g, ''), port }
}

/**
 * 把响应体接成 web 流。取消时若整条消息已经到齐就读空而不是掐断：分段下载读够字节就取消，
 * 掐断会废掉这条隧道，下一段又要重新握手、重新慢启动。
 */
function bodyOf(message: IncomingMessage, onBroken: () => void, onIntact: () => void): ReadableStream<Uint8Array> {
  let settled = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        onBroken()
        controller.error(error)
      }
      message.on('data', (chunk: Buffer) => {
        if (settled) return
        controller.enqueue(chunk)
        if ((controller.desiredSize ?? 0) <= 0) message.pause()
      })
      message.on('end', () => {
        if (settled) return
        settled = true
        onIntact()
        controller.close()
      })
      message.on('error', fail)
      message.on('close', () => fail(new Error('the connection closed before the response finished')))
    },
    pull() {
      message.resume()
    },
    cancel() {
      if (settled) return
      settled = true
      if (message.complete) {
        onIntact()
        message.resume()
      } else {
        message.destroy()
      }
    },
  })
}

function headersOf(message: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      try {
        headers.append(name, item)
      } catch {
        // 一个不合规的头不该废掉整个响应。
      }
    }
  }
  return headers
}

/** 只有不带请求体的 HTTPS GET 才走隧道；其余原样交给 fetch。 */
function tunnelTarget(input: RequestInfo | URL, init: RequestInit | undefined): URL | null {
  if (typeof input !== 'string' && !(input instanceof URL)) return null
  if ((init?.method ?? 'GET').toUpperCase() !== 'GET' || init?.body != null) return null
  try {
    const url = new URL(input)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function createProxyAwareFetch(resolveProxy: ResolveProxy): typeof fetch {
  const agents = new Map<string, https.Agent>()
  const routes = new Map<string, { proxy: ProxyEndpoint | null; expires: number }>()
  /** 连续没拿到响应头的次数。 */
  let headStrikes = 0
  /** 响应体中途断掉的次数，读完整一次清零。 */
  let bodyStrikes = 0

  async function routeFor(url: URL): Promise<ProxyEndpoint | null> {
    const cached = routes.get(url.origin)
    if (cached && cached.expires > Date.now()) return cached.proxy
    let proxy: ProxyEndpoint | null = null
    try {
      proxy = parseProxyRule(await resolveProxy(url.origin))
    } catch {
      // 解析不了就当没有代理。
    }
    routes.set(url.origin, { proxy, expires: Date.now() + ROUTE_TTL_MS })
    return proxy
  }

  function agentFor(proxy: ProxyEndpoint): https.Agent {
    const key = `${proxy.host}:${proxy.port}`
    let agent = agents.get(key)
    if (!agent) {
      const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host
      // 只给这一个变量：不读进程环境里的代理设置，也没有 NO_PROXY 例外。
      // 断言是因为本项目给 ProcessEnv 加了必填项（electron-env.d.ts），而 ProxyEnv 继承自它。
      const proxyEnv = { HTTPS_PROXY: `http://${host}:${proxy.port}` } as unknown as https.AgentOptions['proxyEnv']
      agent = new https.Agent({ keepAlive: true, proxyEnv })
      agents.set(key, agent)
    }
    return agent
  }

  function viaProxy(agent: https.Agent, url: URL, init: RequestInit | undefined): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value
      })
      const signal = init?.signal ?? undefined
      const request = https.request(url, { method: 'GET', agent, headers, signal })
      // 常驻监听：拿到响应头之后的错误（如被取消）没人接会变成未捕获异常。
      request.on('error', reject)
      request.on('response', (message) => {
        try {
          const status = message.statusCode ?? 0
          const bodyless = status === 204 || status === 205 || status === 304
          if (bodyless) message.resume()
          const body = bodyless
            ? null
            : bodyOf(
                message,
                () => {
                  // 调用方自己掐的不算代理的错。
                  if (!signal?.aborted) bodyStrikes += 1
                },
                () => {
                  bodyStrikes = 0
                },
              )
          resolve(new Response(body, { status, headers: headersOf(message) }))
        } catch (error) {
          message.destroy()
          reject(error)
        }
      })
      request.end()
    })
  }

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = tunnelTarget(input, init)
    const usable = target !== null && headStrikes < MAX_STRIKES && bodyStrikes < MAX_STRIKES
    const proxy = usable ? await routeFor(target) : null
    if (target && proxy) {
      try {
        const response = await viaProxy(agentFor(proxy), target, init)
        headStrikes = 0
        return response
      } catch (error) {
        if (init?.signal?.aborted) throw error
        headStrikes += 1
        console.warn(`[proxy] request through ${proxy.host}:${proxy.port} failed, going direct: ${String(error)}`)
      }
    }
    return await fetch(input, init)
  }) as typeof fetch
}
