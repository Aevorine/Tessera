/**
 * 前台感知的子进程调度：窗口在用时后端按正常优先级跑；用户切去别的程序一小会儿后降到
 * 「低于正常」，回来立刻恢复。加解密、清理扫描、建索引照常进行，只是 CPU 紧张时先让给
 * 用户正在用的程序。
 *
 * 只改优先级类，不暂停也不限速：机器有空闲核时降级不损失吞吐。
 * 不接管跨设备守护进程：它的心跳经不起 CPU 饥饿。
 */

import os from 'node:os'

export interface ProcessGovernor {
  /** 接管一个子进程；它重启后拿新 pid 再调一次。 */
  adopt(pid: number | undefined): void
  /** 窗口此刻是否正被使用（可见且有焦点）。 */
  setForeground(foreground: boolean): void
  dispose(): void
}

/** 离开这么久才降级：Alt+Tab 来回切、弹个系统对话框都不该反复改优先级。 */
const DEMOTE_AFTER_MS = 4_000

export function createProcessGovernor(demoteAfterMs = DEMOTE_AFTER_MS): ProcessGovernor {
  let pid: number | null = null
  let demoted = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const apply = () => {
    if (pid === null) return
    const { PRIORITY_BELOW_NORMAL, PRIORITY_NORMAL } = os.constants.priority
    try {
      os.setPriority(pid, demoted ? PRIORITY_BELOW_NORMAL : PRIORITY_NORMAL)
    } catch {
      // 进程刚好退出，或系统不让改：调度只是让路，改不了不影响功能。
    }
  }

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    adopt(next) {
      pid = typeof next === 'number' && next > 0 ? next : null
      // 新进程默认是正常优先级，只有当前处于降级时才需要补一次。
      if (demoted) apply()
    },
    setForeground(foreground) {
      if (foreground) {
        cancelTimer()
        if (demoted) {
          demoted = false
          apply()
        }
        return
      }
      if (demoted || timer !== null) return
      timer = setTimeout(() => {
        timer = null
        demoted = true
        apply()
      }, demoteAfterMs)
    },
    dispose() {
      cancelTimer()
      pid = null
    },
  }
}
