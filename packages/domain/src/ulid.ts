/**
 * ULID：26 字符 Crockford base32（10 时间 + 16 随机），同毫秒内单调递增。
 * 纯函数式本地实现，避免外部依赖。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = -1
let lastRandom: number[] = []

function encodeTime(now: number, len: number): string {
  let out = ''
  for (let i = 0; i < len; i++) {
    out = ENCODING[now % 32] + out
    now = Math.floor(now / 32)
  }
  return out
}

function freshRandom(len: number): number[] {
  const vals: number[] = []
  for (let i = 0; i < len; i++) vals.push(Math.floor(Math.random() * 32))
  return vals
}

function incrementRandom(vals: number[]): number[] {
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i]! < 31) {
      const next = [...vals]
      next[i] = vals[i]! + 1
      for (let j = i + 1; j < next.length; j++) next[j] = 0
      return next
    }
  }
  return freshRandom(vals.length)
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime && lastRandom.length > 0) {
    lastRandom = incrementRandom(lastRandom)
  } else {
    lastRandom = freshRandom(16)
  }
  lastTime = now
  return encodeTime(now, 10) + lastRandom.map((v) => ENCODING[v]!).join('')
}
