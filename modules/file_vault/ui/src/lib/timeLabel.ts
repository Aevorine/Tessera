const pad = (n: number) => String(n).padStart(2, '0')

function parse(v: string | number): Date | null {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 列表用短时间：今天只写时分秒，今年省年份。 */
export function shortTime(v: string | number, now = new Date()): string {
  const d = parse(v)
  if (!d) return String(v)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return `${hm}:${pad(d.getSeconds())}`
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`
}

/** 详情用完整时间 YYYY-MM-DD HH:mm:ss。 */
export function fullTime(v: string | number): string {
  const d = parse(v)
  if (!d) return String(v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
