package com.tessera.crossdevice

enum class TransferEventAction {
    IGNORE,
    HIDE_PROGRESS,
    HIDE_PROGRESS_WITH_ERROR,
    DELIVER_RECEIVED_FILE,
    /** 对方不在线，文件已排队；上线后自动补发 */
    QUEUED,
    /** 对方上线，正在补发排队的文件 */
    OUTBOX_DRAIN,
}

object TransferEventRouter {
    fun route(kind: String?, path: String?): TransferEventAction = when (kind) {
        "done" -> TransferEventAction.HIDE_PROGRESS
        // 用户自己按的取消不是错误。弹一句红色的失败提示，等于告诉他"你刚才那下
        // 操作出问题了"——而事情完全按他的意思发生了。收进度条，不报错。
        "canceled" -> TransferEventAction.HIDE_PROGRESS
        "error" -> TransferEventAction.HIDE_PROGRESS_WITH_ERROR
        "queued" -> TransferEventAction.QUEUED
        "outbox_drain" -> TransferEventAction.OUTBOX_DRAIN
        "recv_done" -> if (path.isNullOrBlank()) {
            TransferEventAction.IGNORE
        } else {
            TransferEventAction.DELIVER_RECEIVED_FILE
        }
        else -> TransferEventAction.IGNORE
    }
}
