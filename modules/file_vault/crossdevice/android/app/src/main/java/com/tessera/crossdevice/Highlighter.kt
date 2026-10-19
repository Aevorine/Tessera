package com.tessera.crossdevice

import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan

internal class Highlighter(
    private val engine: SmartSearch? = null,
    private val query: SmartQuery = SmartQuery.EMPTY,
    private val color: Int = 0x40808080,
) {
    fun apply(text: String): CharSequence {
        if (engine == null || query.isEmpty) return text
        return SpannableString(text).apply {
            engine.highlightRanges(query, text).forEach { range ->
                if (range.first >= 0 && range.last < text.length && !range.isEmpty())
                    setSpan(BackgroundColorSpan(color), range.first, range.last + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
    }
    companion object { val NONE = Highlighter() }
}
